/**
 * Digest helpers.
 * @module core/hash
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { stableStringify } from './json.js';
/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Text(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** SHA-256 of raw bytes, lowercase hex. */
export function sha256Bytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/** SHA-256 of a lossless JSON value, independent of key order. */
export function sha256Json(value) {
    return sha256Text(stableStringify(value));
}
/** A short opaque token, for request ids and temp names. */
export function randomToken(bytes = 8) {
    return randomBytes(bytes).toString('hex');
}
/** A random UUID v4. */
export function randomId() {
    return randomUUID();
}
