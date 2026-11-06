/**
 * Digest helpers.
 * @module core/hash
 */
import type { JsonValue } from '../types.js';
/** SHA-256 of a UTF-8 string, lowercase hex. */
export declare function sha256Text(text: string): string;
/** SHA-256 of raw bytes, lowercase hex. */
export declare function sha256Bytes(bytes: Uint8Array): string;
/** SHA-256 of a lossless JSON value, independent of key order. */
export declare function sha256Json(value: JsonValue): string;
/** A short opaque token, for request ids and temp names. */
export declare function randomToken(bytes?: number): string;
/** A random UUID v4. */
export declare function randomId(): string;
