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
/** Algorithm identifier placed in the `Authorization` header. */
export declare const AWS_SIGNATURE_ALGORITHM = "AWS4-HMAC-SHA256";
/** Payload placeholder accepted by S3 for streaming bodies. */
export declare const AWS_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** Credentials of one AWS principal (long-lived or temporary). */
export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    /** Present for temporary credentials (STS, IMDS, SSO). */
    sessionToken?: string;
}
/** Everything needed to sign one HTTP request. */
export interface AwsSignInput {
    /** Upper-case HTTP verb. */
    method: string;
    /** Absolute request URL including its query string. */
    url: string;
    /** Extra headers to sign and forward (`host` and `x-amz-date` are added). */
    headers?: Record<string, string>;
    /** Request body; only its hash is used, the body itself is not retained. */
    body?: string | Uint8Array | null;
    /** AWS region (`us-east-1` for most S3 gateways, `auto` for Cloudflare R2). */
    region: string;
    /** AWS service name (`s3` for every object-store call). */
    service: string;
    credentials: AwsCredentials;
    /** Signing instant; defaults to the current clock. Tests pass a fixed date. */
    date?: Date;
    /**
     * Add the `x-amz-content-sha256` header. S3 requires it (and a missing header
     * makes some gateways reject the request), so this defaults to `true`; the
     * AWS SigV4 conformance vectors set it to `false`.
     */
    includePayloadHashHeader?: boolean;
    /**
     * Override the payload hash carried into the canonical request, e.g.
     * {@link AWS_UNSIGNED_PAYLOAD} for a body whose bytes are not available.
     */
    payloadHash?: string;
}
/** Result of {@link signAwsV4}: headers to send plus every derived value. */
export interface AwsSignedRequest {
    /** Headers that must be sent with the request, including `Authorization`. */
    headers: Record<string, string>;
    authorization: string;
    /** `yyyyMMdd'T'HHmmss'Z'` stamp used for the signature. */
    amzDate: string;
    payloadHash: string;
    signedHeaders: string;
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
}
/** SHA-256 of a UTF-8 string or byte buffer, lowercase hex. */
export declare function sha256Hex(data: string | Uint8Array): string;
/** HMAC-SHA256 returning raw bytes. */
export declare function hmacSha256(key: string | Uint8Array, data: string): Buffer;
/**
 * Percent-encode per RFC 3986 as SigV4 requires.
 *
 * Unlike `encodeURIComponent`, `!'()*` are escaped as well, and `/` is escaped
 * unless the caller opts out (the canonical URI keeps its separators).
 */
export declare function uriEncode(value: string, encodeSlash?: boolean): string;
/** `yyyyMMdd'T'HHmmss'Z'` timestamp used by `x-amz-date`. */
export declare function amzDateString(date: Date): string;
/** `yyyyMMdd` scope date. */
export declare function amzScopeDate(date: Date): string;
/**
 * Canonical URI: each path segment is decoded and re-encoded exactly once, so a
 * caller that already encoded a key never double-encodes it.
 */
export declare function canonicalUri(pathname: string): string;
/**
 * Canonical query string: parameters sorted by encoded name then encoded value
 * and joined with `&`, every name and value RFC 3986 encoded.
 */
export declare function canonicalQueryString(search: string): string;
/**
 * Sign one HTTP request with SigV4.
 *
 * @param input - request, credentials and signing instant.
 * @returns headers to send plus the intermediate signing artifacts.
 */
export declare function signAwsV4(input: AwsSignInput): AwsSignedRequest;
