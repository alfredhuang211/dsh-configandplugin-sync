/**
 * S3-compatible storage backend.
 *
 * Implements ListObjectsV2 / GetObject / PutObject / DeleteObject straight over
 * the global `fetch`, signing each request with the locally implemented SigV4
 * from {@link module:backends/sigv4}. Path-style and virtual-host addressing are
 * both supported, as are regions, session tokens and custom gateway endpoints
 * (MinIO, R2, B2, ...). Keys are joined segment-wise, so a configured prefix and
 * the store path can never produce a `//`.
 *
 * **Revision model.** Like WebDAV there is no commit id: the revision is a
 * SHA-256 over the sorted `(path, content digest)` pairs of the store, `null`
 * for an empty store. It is a pure function of the documents, so two devices
 * that see the same bytes agree, and an external writer changes it.
 *
 * **Concurrency.** The caller passes the revision it read; a mismatch fails the
 * write with {@link SyncError} code `conflict` instead of overwriting another
 * device. On top of that check, the objects being touched are re-listed and
 * their ETags compared with the ones observed at read time, and PUT carries
 * `If-Match` (or `If-None-Match: *` for a new object). S3 has no multi-object
 * transaction, so this is best-effort protection, which is exactly what the
 * engine can compensate for by re-reading.
 *
 * No credential is ever logged, included in a destination or embedded in a
 * message: only the access key id and bucket/prefix shapes are informational.
 * @module backends/s3
 */
import { MAX_DOCUMENT_BYTES, MAX_STORE_FILES } from '../constants.js';
import { SyncError, errorMessage } from '../core/errors.js';
import { sha256Bytes, sha256Text } from '../core/hash.js';
import { normalizeStorePath } from '../core/paths.js';
import { redactText, sanitizeUrl } from '../core/redact.js';
import { signAwsV4, uriEncode } from './sigv4.js';
/** Per-request timeout in milliseconds. */
export const S3_TIMEOUT_MS = 60_000;
/** Objects requested per ListObjectsV2 page (the S3 maximum). */
export const S3_LIST_PAGE_SIZE = 1_000;
/** Whether a caller signal is already aborted. */
function isAborted(signal) {
    return signal?.aborted === true;
}
/** Decode the XML entities a response may contain. */
function decodeXmlText(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&amp;/g, '&');
}
/** Strip namespace prefixes from very small S3 XML documents. */
function stripXmlPrefixes(xml) {
    return xml.replace(/<(\/?)[A-Za-z0-9_.-]+:/g, '<$1');
}
/** Read the inner text of the first occurrence of one tag. */
function xmlTag(xml, tag) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return match === null ? undefined : decodeXmlText((match[1] ?? '').trim());
}
/** Split one XML document into its `<Contents>` blocks. */
function xmlBlocks(xml, tag) {
    return xml.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi')) ?? [];
}
/**
 * Join key parts with exactly one `/` between segments.
 *
 * @throws {SyncError} `invalid-config` for a `..` segment or a NUL byte.
 */
export function joinS3Key(...parts) {
    const segments = [];
    for (const part of parts) {
        if (part === undefined)
            continue;
        for (const rawSegment of part.split('/')) {
            const segment = rawSegment.trim();
            if (segment === '' || segment === '.')
                continue;
            if (segment === '..') {
                throw new SyncError('invalid-config', 'S3 前缀不能包含 .. / the S3 prefix must not contain ..');
            }
            if (segment.includes('\u0000')) {
                throw new SyncError('invalid-config', 'S3 前缀包含 NUL 字节 / the S3 prefix contains a NUL byte');
            }
            segments.push(segment);
        }
    }
    return segments.join('/');
}
/** Build the URL of one S3 object (or of the bucket root when `key === ''`). */
export function buildS3ObjectUrl(address) {
    const endpoint = new URL(address.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const encodedKey = address.key
        .split('/')
        .filter(segment => segment !== '')
        .map(segment => uriEncode(segment))
        .join('/');
    const segments = [];
    const baseSegments = basePath.replace(/^\/+/, '');
    if (baseSegments !== '')
        segments.push(baseSegments);
    if (address.forcePathStyle)
        segments.push(uriEncode(address.bucket));
    if (encodedKey !== '')
        segments.push(encodedKey);
    const pathname = `/${segments.join('/')}`;
    const host = address.forcePathStyle ? endpoint.host : `${address.bucket}.${endpoint.host}`;
    return new URL(`${endpoint.protocol}//${host}${pathname === '/' ? '/' : pathname}`);
}
/** Compute the store revision over a path → content-digest map. */
export function computeS3Revision(digests) {
    if (digests.size === 0)
        return null;
    const lines = [...digests.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, digest]) => `${path}\u0000${digest}`);
    return `sha256:${sha256Text(lines.join('\n'))}`;
}
/** Strip surrounding quotes from an HTTP ETag. */
function stripEtagQuotes(value) {
    const trimmed = (value ?? '').trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
        return trimmed.slice(1, -1);
    return trimmed;
}
/** Validate the S3 configuration and derive every value the client needs. */
export function normalizeS3Config(config, storePath = '') {
    const rawEndpoint = (config.endpoint ?? '').trim();
    if (rawEndpoint === '') {
        throw new SyncError('not-configured', '尚未配置 S3 端点 / the S3 endpoint is not configured');
    }
    let endpoint;
    try {
        endpoint = new URL(rawEndpoint);
    }
    catch {
        throw new SyncError('invalid-config', `S3 端点无效 / invalid S3 endpoint: ${redactText(rawEndpoint)}`);
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
        throw new SyncError('invalid-config', `S3 端点必须是 http(s) / the S3 endpoint must be http(s): ${endpoint.protocol}`);
    }
    if (endpoint.username !== '' || endpoint.password !== '') {
        throw new SyncError('invalid-config', 'S3 端点不能内嵌凭据，请使用访问密钥设置 / the S3 endpoint must not embed credentials; use the access keys');
    }
    const bucket = (config.bucket ?? '').trim();
    if (bucket === '') {
        throw new SyncError('not-configured', '尚未配置 S3 存储桶 / the S3 bucket is not configured');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(bucket)) {
        throw new SyncError('invalid-config', `S3 存储桶名称无效 / invalid S3 bucket name: ${redactText(bucket)}`);
    }
    const region = (config.region ?? '').trim() === '' ? 'us-east-1' : (config.region ?? '').trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(region)) {
        throw new SyncError('invalid-config', `S3 区域无效 / invalid S3 region: ${redactText(region)}`);
    }
    const accessKeyId = (config.accessKeyId ?? '').trim();
    const secretAccessKey = config.secretAccessKey ?? '';
    if (accessKeyId === '' || secretAccessKey === '') {
        throw new SyncError('not-configured', '尚未配置 S3 访问密钥 / the S3 access key id and secret access key are not configured');
    }
    const sessionToken = (config.sessionToken ?? '').trim();
    const prefix = joinS3Key(config.prefix);
    const resolvedStorePath = joinS3Key(storePath);
    const rootPrefix = joinS3Key(prefix, resolvedStorePath);
    endpoint.search = '';
    endpoint.hash = '';
    return {
        endpoint: endpoint.toString(),
        region,
        bucket,
        forcePathStyle: config.forcePathStyle === true,
        rootPrefix,
        storePath: resolvedStorePath,
        credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken === '' ? {} : { sessionToken }),
        },
    };
}
/**
 * Credential-free destination string for the settings page.
 *
 * Never throws: an incomplete configuration must still render.
 */
export function describeS3Destination(config, storePath = '') {
    const rawEndpoint = (config.endpoint ?? '').trim();
    const endpoint = rawEndpoint === '' ? '(未配置 / not configured)' : sanitizeUrl(rawEndpoint).replace(/\/+$/, '');
    let prefix;
    try {
        prefix = joinS3Key(config.prefix, storePath);
    }
    catch {
        prefix = '';
    }
    const bucket = (config.bucket ?? '').trim();
    const bucketPart = bucket === '' ? '(未配置 / not configured)' : bucket;
    return `s3 ${endpoint}/${bucketPart}${prefix === '' ? '' : `/${prefix}`}`;
}
/** Sanitize a store-relative path, rejecting traversal and absolute paths. */
function safeStorePath(path) {
    try {
        return normalizeStorePath(path);
    }
    catch (error) {
        throw new SyncError('invalid-config', redactText(errorMessage(error)));
    }
}
/**
 * Create the S3-compatible storage backend.
 *
 * Construction performs no I/O; the first operation validates and connects.
 */
export function createS3Backend(config, options) {
    const logger = options.logger;
    const kind = 's3';
    let cachedSettings = null;
    const settings = () => {
        if (cachedSettings !== null)
            return cachedSettings;
        cachedSettings = normalizeS3Config(config, options.storePath ?? '');
        return cachedSettings;
    };
    /** Build the URL of one key (bucket root when `key === ''`). */
    const objectUrl = (key) => {
        const current = settings();
        return buildS3ObjectUrl({
            endpoint: current.endpoint,
            bucket: current.bucket,
            key,
            forcePathStyle: current.forcePathStyle,
        });
    };
    /** Build the URL of a store document. */
    const documentUrl = (relativePath) => objectUrl(joinS3Key(settings().rootPrefix, relativePath));
    /** Build the response error for one status code. */
    const statusError = (method, status, detail) => {
        const context = redactText(detail);
        if (status === 401 || status === 403) {
            return new SyncError('auth-failed', `S3 认证失败 / S3 authentication failed (${method} ${context})`);
        }
        if (status === 404) {
            return new SyncError('not-found', `S3 资源不存在 / the S3 resource was not found (${method} ${context})`);
        }
        if (status === 409 || status === 412) {
            return new SyncError('conflict', `S3 对象已被其他设备修改 / the S3 object changed concurrently (${method} ${context})`);
        }
        if (status === 400) {
            return new SyncError('invalid-config', `S3 请求被拒绝 / the S3 request was rejected (${method} ${context})`);
        }
        if (status === 429 || status >= 500) {
            return new SyncError('network', `S3 服务暂时不可用 / the S3 service is unavailable (${status})`);
        }
        return new SyncError('internal', `S3 请求失败 / the S3 request failed (${method} ${status} ${context})`);
    };
    /** Send one signed request. */
    const send = async (method, url, requestOptions = {}) => {
        const callerSignal = requestOptions.signal;
        if (isAborted(callerSignal)) {
            throw new SyncError('cancelled', '操作已取消 / operation cancelled');
        }
        const current = settings();
        const timeout = AbortSignal.timeout(S3_TIMEOUT_MS);
        const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
        const signed = signAwsV4({
            method,
            url: url.toString(),
            headers: requestOptions.headers,
            body: requestOptions.body,
            region: current.region,
            service: 's3',
            credentials: current.credentials,
        });
        try {
            return await fetch(url, {
                method,
                headers: signed.headers,
                ...(requestOptions.body === undefined ? {} : { body: requestOptions.body }),
                signal,
                redirect: 'manual',
                cache: 'no-store',
            });
        }
        catch (error) {
            if (isAborted(callerSignal)) {
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            }
            if (error?.name === 'TimeoutError') {
                throw new SyncError('network', `${method} 请求超时 / ${method} request timed out`);
            }
            throw new SyncError('network', redactText(`${method} 请求失败 / ${method} request failed: ${errorMessage(error)}`));
        }
    };
    /** Read the S3 error code from a failed response body, when present. */
    const errorDetail = async (response) => {
        try {
            const text = await response.text();
            const code = xmlTag(stripXmlPrefixes(text), 'Code');
            return code === undefined ? '' : `: ${code}`;
        }
        catch {
            return '';
        }
    };
    /** One ListObjectsV2 page. */
    const listPage = async (prefix, maxKeys, continuationToken, signal) => {
        const url = objectUrl('');
        url.searchParams.set('list-type', '2');
        url.searchParams.set('max-keys', String(maxKeys));
        if (prefix !== '')
            url.searchParams.set('prefix', prefix);
        if (continuationToken !== undefined && continuationToken !== '') {
            url.searchParams.set('continuation-token', continuationToken);
        }
        const response = await send('GET', url, { signal });
        if (!response.ok) {
            const detail = await errorDetail(response);
            throw statusError('ListObjectsV2', response.status, `bucket ${settings().bucket}${detail}`);
        }
        const xml = stripXmlPrefixes(await response.text());
        const objects = [];
        for (const block of xmlBlocks(xml, 'Contents')) {
            const key = xmlTag(block, 'Key');
            if (key === undefined || key === '')
                continue;
            const rawEtag = xmlTag(block, 'ETag');
            const etag = rawEtag === undefined || rawEtag === '' ? undefined : rawEtag;
            const rawSize = xmlTag(block, 'Size');
            const parsedSize = rawSize === undefined ? Number.NaN : Number.parseInt(rawSize, 10);
            objects.push({
                key,
                ...(etag === undefined ? {} : { etag }),
                ...(Number.isFinite(parsedSize) && parsedSize >= 0 ? { size: parsedSize } : {}),
            });
        }
        const truncated = (xmlTag(xml, 'IsTruncated') ?? '').toLowerCase() === 'true';
        const nextToken = xmlTag(xml, 'NextContinuationToken');
        return {
            objects,
            truncated,
            ...(nextToken === undefined || nextToken === '' ? {} : { nextToken }),
        };
    };
    /** List every object under one prefix, following continuation tokens. */
    const listAll = async (prefix, signal) => {
        const objects = [];
        let token;
        for (;;) {
            if (isAborted(signal))
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            const page = await listPage(prefix, S3_LIST_PAGE_SIZE, token, signal);
            objects.push(...page.objects);
            if (objects.length > MAX_STORE_FILES) {
                throw new SyncError('invalid-config', `存储对象数量超过上限 ${MAX_STORE_FILES} / the store has more objects than the limit (${MAX_STORE_FILES})`);
            }
            if (!page.truncated || page.nextToken === undefined)
                break;
            token = page.nextToken;
        }
        return objects;
    };
    /** Read one object; null when it no longer exists. */
    const getObject = async (key, signal) => {
        const response = await send('GET', objectUrl(key), { signal });
        if (response.status === 404)
            return null;
        if (!response.ok) {
            const detail = await errorDetail(response);
            throw statusError('GetObject', response.status, `key ${key}${detail}`);
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && /^\d+$/.test(declared) && Number.parseInt(declared, 10) > MAX_DOCUMENT_BYTES) {
            throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${key}`);
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
            throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${key}`);
        }
        return new Uint8Array(buffer);
    };
    /** Put one object with a best-effort compare-and-swap precondition. */
    const putObject = async (key, bytes, conditional, signal) => {
        const response = await send('PUT', objectUrl(key), {
            body: bytes,
            headers: { 'content-type': 'application/octet-stream', ...conditional },
            signal,
        });
        if (!response.ok) {
            const detail = await errorDetail(response);
            throw statusError('PutObject', response.status, `key ${key}${detail}`);
        }
        const etag = stripEtagQuotes(response.headers.get('etag'));
        return etag === '' ? undefined : etag;
    };
    /** Delete one object; a missing object is a no-op. */
    const deleteObject = async (key, signal) => {
        const response = await send('DELETE', objectUrl(key), { signal });
        if (response.status === 404)
            return;
        if (!response.ok) {
            const detail = await errorDetail(response);
            throw statusError('DeleteObject', response.status, `key ${key}${detail}`);
        }
    };
    let cache = null;
    const read = async (signal) => {
        const current = settings();
        const prefix = current.rootPrefix === '' ? '' : `${current.rootPrefix}/`;
        const listing = await listAll(prefix, signal);
        const files = new Map();
        const digests = new Map();
        const etags = new Map();
        const seen = new Set();
        for (const object of listing) {
            if (isAborted(signal))
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            if (object.key.endsWith('/'))
                continue; // a zero-byte "directory" marker
            if (!object.key.startsWith(prefix))
                continue;
            const relative = object.key.slice(prefix.length);
            if (relative === '')
                continue;
            // Keys are flat strings on S3: a key may name a "path" with any shape, so
            // normalize it exactly like a filesystem path before accepting it.
            const path = safeStorePath(relative);
            if (seen.has(path))
                continue;
            seen.add(path);
            if (object.size !== undefined && object.size > MAX_DOCUMENT_BYTES) {
                throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`);
            }
            const bytes = await getObject(object.key, signal);
            if (bytes === null) {
                logger.warn('a store object disappeared while reading', { path });
                continue;
            }
            const digest = sha256Bytes(bytes);
            files.set(path, bytes);
            digests.set(path, digest);
            if (object.etag !== undefined && object.etag !== '')
                etags.set(path, object.etag);
        }
        cache = { revision: computeS3Revision(digests), digests, etags };
        logger.info('store read', { documents: files.size, revision: cache.revision });
        return { revision: cache.revision, files };
    };
    /** Normalize the caller's write into safe, unique, size-checked documents. */
    const normalizeFiles = (files) => {
        if (!(files instanceof Map)) {
            throw new SyncError('invalid-config', '待写入文件必须是映射 / files must be a Map');
        }
        if (files.size > MAX_STORE_FILES) {
            throw new SyncError('invalid-config', `文件数量超过上限 ${MAX_STORE_FILES} / too many files (limit ${MAX_STORE_FILES})`);
        }
        const out = [];
        const seen = new Set();
        for (const [rawPath, bytes] of files) {
            const path = safeStorePath(rawPath);
            if (seen.has(path))
                throw new SyncError('invalid-config', `重复的文件路径 / duplicate store path: ${path}`);
            seen.add(path);
            if (!(bytes instanceof Uint8Array)) {
                throw new SyncError('invalid-config', `文件内容必须是字节 / file content must be bytes: ${path}`);
            }
            if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
                throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`);
            }
            out.push({ path, bytes, digest: sha256Bytes(bytes) });
        }
        out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        return out;
    };
    /** Normalize the caller's deletion list. */
    const normalizeDeletions = (deletions) => {
        if (!Array.isArray(deletions)) {
            throw new SyncError('invalid-config', 'deletions 必须是数组 / deletions must be an array');
        }
        if (deletions.length > MAX_STORE_FILES) {
            throw new SyncError('invalid-config', `删除数量超过上限 ${MAX_STORE_FILES} / too many deletions (limit ${MAX_STORE_FILES})`);
        }
        const out = [];
        const seen = new Set();
        for (const rawPath of deletions) {
            const path = safeStorePath(rawPath);
            if (seen.has(path))
                continue;
            seen.add(path);
            out.push(path);
        }
        return out;
    };
    const write = async (request) => {
        if (isAborted(request.signal))
            throw new SyncError('cancelled', '操作已取消 / operation cancelled');
        const current = settings();
        const files = normalizeFiles(request.files);
        const deletions = normalizeDeletions(request.deletions);
        // The caller's revision is authoritative: re-read the store and compare, so
        // a concurrent change is detected even when none of *our* objects changed.
        if (request.expectedRevision !== null || cache === null)
            await read(request.signal);
        const snapshot = cache;
        if (snapshot === null)
            throw new SyncError('internal', '存储状态不可用 / the store state is unavailable');
        if (request.expectedRevision !== null && request.expectedRevision !== snapshot.revision) {
            throw new SyncError('conflict', '存储已被其他设备更新，请重新读取后再写入 / the store changed since it was read; read it again before writing', { expectedRevision: request.expectedRevision, actualRevision: snapshot.revision });
        }
        const pendingWrites = files.filter(file => snapshot.digests.get(file.path) !== file.digest);
        const pendingDeletions = deletions.filter(path => snapshot.digests.has(path));
        if (pendingWrites.length === 0 && pendingDeletions.length === 0) {
            logger.debug('store write made no changes');
            return { changed: false, revision: snapshot.revision, changedFiles: [], retried: false };
        }
        // Re-list once and verify the ETags of every object this write touches. S3
        // has no atomic multi-object write, so this narrows (not closes) the race.
        const prefix = current.rootPrefix === '' ? '' : `${current.rootPrefix}/`;
        const listing = await listAll(prefix, request.signal);
        const currentEtag = new Map();
        for (const object of listing) {
            if (object.key.endsWith('/') || !object.key.startsWith(prefix))
                continue;
            const relative = object.key.slice(prefix.length);
            if (relative === '')
                continue;
            currentEtag.set(relative, object.etag);
        }
        const assertUnchanged = (path) => {
            const known = snapshot.digests.has(path);
            const nowExists = currentEtag.has(path);
            if (!known) {
                if (nowExists) {
                    throw new SyncError('conflict', `文档在读取后被其他设备创建 / another device created the document after it was read: ${path}`);
                }
                return;
            }
            if (!nowExists) {
                throw new SyncError('conflict', `文档在读取后被其他设备删除 / another device deleted the document after it was read: ${path}`);
            }
            const before = snapshot.etags.get(path);
            const after = currentEtag.get(path);
            if (before !== undefined && after !== undefined && before !== after) {
                throw new SyncError('conflict', `文档在读取后被其他设备修改 / another device modified the document after it was read: ${path}`);
            }
        };
        for (const file of pendingWrites)
            assertUnchanged(file.path);
        for (const path of pendingDeletions)
            assertUnchanged(path);
        const digests = new Map(snapshot.digests);
        const etags = new Map(snapshot.etags);
        const changedFiles = [];
        for (const path of pendingDeletions) {
            if (isAborted(request.signal))
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            await deleteObject(joinS3Key(current.rootPrefix, path), request.signal);
            digests.delete(path);
            etags.delete(path);
            changedFiles.push(path);
        }
        for (const file of pendingWrites) {
            if (isAborted(request.signal))
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            const etag = snapshot.etags.get(file.path);
            const conditional = etag !== undefined ? { 'if-match': etag } : { 'if-none-match': '*' };
            const newEtag = await putObject(joinS3Key(current.rootPrefix, file.path), file.bytes, conditional, request.signal);
            digests.set(file.path, file.digest);
            if (newEtag === undefined)
                etags.delete(file.path);
            else
                etags.set(file.path, newEtag);
            changedFiles.push(file.path);
        }
        changedFiles.sort();
        const revision = computeS3Revision(digests);
        cache = { revision, digests, etags };
        logger.info('store written', { changedFiles: changedFiles.length, revision });
        return { changed: true, revision, changedFiles, retried: false };
    };
    const history = async (_historyOptions = {}) => {
        // Object stores have no revision history; the engine keeps its own log.
        return [];
    };
    const testConnection = async (signal) => {
        const at = new Date().toISOString();
        try {
            const current = settings();
            const prefix = current.rootPrefix === '' ? '' : `${current.rootPrefix}/`;
            const page = await listPage(prefix, 1, undefined, signal);
            logger.info('s3 connection test succeeded', { objects: page.objects.length });
            return {
                ok: true,
                at,
                kind,
                revision: cache?.revision ?? null,
                message: page.truncated
                    ? '已连接 S3 存储 / connected to the S3 store'
                    : `已连接 S3 存储 / connected to the S3 store (${page.objects.length} object(s) visible)`,
                authMethod: current.credentials.sessionToken === undefined ? 'access-key' : 'access-key+session-token',
            };
        }
        catch (error) {
            const message = error instanceof SyncError ? error.message : errorMessage(error);
            logger.warn('s3 connection test failed', { code: error instanceof SyncError ? error.code : 'internal' });
            return { ok: false, at, kind, revision: null, message: redactText(message), authMethod: 'access-key' };
        }
    };
    return {
        kind,
        destination: describeS3Destination(config, options.storePath ?? ''),
        read,
        write,
        history,
        testConnection,
    };
}
