/**
 * AWS Signature Version 4, implemented locally over `node:crypto`.
 *
 * The S3 backend deliberately avoids `@aws-sdk/*`: this plugin may only use
 * Node builtins and the global `fetch`, and SigV4 is small enough to own. The
 * module exposes the intermediate values of the signing process (canonical
 * request, string to sign, signature) so tests can pin them against an
 * independently computed reference and so a failure can be diagnosed from a
 * log line without ever printing a secret.
 *
 * Only request signing is implemented. Presigned URLs are not needed: every S3
 * call carries an `Authorization` header on the wire.
 * @module backends/sigv4
 */
import { createHash, createHmac } from 'node:crypto';
/** Algorithm identifier placed in the `Authorization` header. */
export const AWS_SIGNATURE_ALGORITHM = 'AWS4-HMAC-SHA256';
/** Payload placeholder accepted by S3 for streaming bodies. */
export const AWS_UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** SHA-256 of a UTF-8 string or byte buffer, lowercase hex. */
export function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
/** HMAC-SHA256 returning raw bytes. */
export function hmacSha256(key, data) {
    return createHmac('sha256', key).update(data, 'utf8').digest();
}
/**
 * Percent-encode per RFC 3986 as SigV4 requires.
 *
 * Unlike `encodeURIComponent`, `!'()*` are escaped as well, and `/` is escaped
 * unless the caller opts out (the canonical URI keeps its separators).
 */
export function uriEncode(value, encodeSlash = true) {
    const bytes = Buffer.from(value, 'utf8');
    let out = '';
    for (const byte of bytes) {
        const char = String.fromCharCode(byte);
        const unreserved = (byte >= 0x30 && byte <= 0x39) || // 0-9
            (byte >= 0x41 && byte <= 0x5a) || // A-Z
            (byte >= 0x61 && byte <= 0x7a) || // a-z
            char === '-' ||
            char === '.' ||
            char === '_' ||
            char === '~' ||
            (char === '/' && !encodeSlash);
        out += unreserved ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
}
/** `yyyyMMdd'T'HHmmss'Z'` timestamp used by `x-amz-date`. */
export function amzDateString(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
/** `yyyyMMdd` scope date. */
export function amzScopeDate(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
}
/**
 * Canonical URI: each path segment is decoded and re-encoded exactly once, so a
 * caller that already encoded a key never double-encodes it.
 */
export function canonicalUri(pathname) {
    const raw = pathname === '' ? '/' : pathname;
    const encoded = raw
        .split('/')
        .map(segment => {
        let decoded = segment;
        try {
            decoded = decodeURIComponent(segment);
        }
        catch {
            // A malformed escape stays literal; encoding it is the safe behaviour.
        }
        return uriEncode(decoded, true);
    })
        .join('/');
    return encoded.startsWith('/') ? encoded : `/${encoded}`;
}
/**
 * Canonical query string: parameters sorted by encoded name then encoded value
 * and joined with `&`, every name and value RFC 3986 encoded.
 */
export function canonicalQueryString(search) {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const pairs = [];
    for (const [name, value] of params)
        pairs.push([uriEncode(name), uriEncode(value)]);
    pairs.sort((left, right) => {
        if (left[0] !== right[0])
            return left[0] < right[0] ? -1 : 1;
        if (left[1] === right[1])
            return 0;
        return left[1] < right[1] ? -1 : 1;
    });
    return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}
/** Trim and collapse whitespace the way SigV4 canonicalizes header values. */
function canonicalHeaderValue(value) {
    return value.trim().replace(/\s+/g, ' ');
}
/**
 * Sign one HTTP request with SigV4.
 *
 * @param input - request, credentials and signing instant.
 * @returns headers to send plus the intermediate signing artifacts.
 */
export function signAwsV4(input) {
    const method = input.method.toUpperCase();
    const url = new URL(input.url);
    const date = input.date ?? new Date();
    const amzDate = amzDateString(date);
    const scopeDate = amzScopeDate(date);
    const payloadHash = input.payloadHash ??
        (input.body === undefined || input.body === null
            ? sha256Hex('')
            : sha256Hex(typeof input.body === 'string' ? input.body : input.body));
    // Lower-cased header map. `host` is mandatory; `authorization` is never signed.
    const headers = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
        const key = name.toLowerCase();
        if (key === 'authorization' || key === 'host' || key === 'x-amz-date')
            continue;
        if (value === '')
            continue;
        headers[key] = value;
    }
    headers.host = url.host;
    headers['x-amz-date'] = amzDate;
    if (input.includePayloadHashHeader !== false)
        headers['x-amz-content-sha256'] = payloadHash;
    const sessionToken = input.credentials.sessionToken;
    if (sessionToken !== undefined && sessionToken !== '')
        headers['x-amz-security-token'] = sessionToken;
    const sortedNames = Object.keys(headers).sort();
    const canonicalHeaders = sortedNames.map(name => `${name}:${canonicalHeaderValue(headers[name] ?? '')}\n`).join('');
    const signedHeaders = sortedNames.join(';');
    const canonicalRequest = [
        method,
        canonicalUri(url.pathname),
        canonicalQueryString(url.search),
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');
    const credentialScope = `${scopeDate}/${input.region}/${input.service}/aws4_request`;
    const stringToSign = [
        AWS_SIGNATURE_ALGORITHM,
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n');
    const dateKey = hmacSha256(`AWS4${input.credentials.secretAccessKey}`, scopeDate);
    const regionKey = hmacSha256(dateKey, input.region);
    const serviceKey = hmacSha256(regionKey, input.service);
    const signingKey = hmacSha256(serviceKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const authorization = `${AWS_SIGNATURE_ALGORITHM} Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return {
        headers: { ...headers, authorization },
        authorization,
        amzDate,
        payloadHash,
        signedHeaders,
        canonicalRequest,
        stringToSign,
        signature,
    };
}
