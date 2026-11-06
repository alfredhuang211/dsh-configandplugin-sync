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
import type { S3BackendConfig, SyncBackend } from '../types.js';
import type { BackendOptions } from './index.js';
import { type AwsCredentials } from './sigv4.js';
/** Per-request timeout in milliseconds. */
export declare const S3_TIMEOUT_MS = 60000;
/** Objects requested per ListObjectsV2 page (the S3 maximum). */
export declare const S3_LIST_PAGE_SIZE = 1000;
/** Validated, derived view of {@link S3BackendConfig}. */
export interface S3Settings {
    /** Base endpoint URL (never contains credentials). */
    endpoint: string;
    region: string;
    bucket: string;
    forcePathStyle: boolean;
    /** `prefix` + store path, joined without duplicate slashes (`''` = bucket root). */
    rootPrefix: string;
    /** Store directory, useful for URLs and diagnostics. */
    storePath: string;
    credentials: AwsCredentials;
}
/** Addressing inputs of {@link buildS3ObjectUrl}. */
export interface S3Address {
    endpoint: string;
    bucket: string;
    /** Object key; `''` addresses the bucket root (for a listing). */
    key: string;
    forcePathStyle: boolean;
}
/**
 * Join key parts with exactly one `/` between segments.
 *
 * @throws {SyncError} `invalid-config` for a `..` segment or a NUL byte.
 */
export declare function joinS3Key(...parts: ReadonlyArray<string | undefined>): string;
/** Build the URL of one S3 object (or of the bucket root when `key === ''`). */
export declare function buildS3ObjectUrl(address: S3Address): URL;
/** Compute the store revision over a path → content-digest map. */
export declare function computeS3Revision(digests: ReadonlyMap<string, string>): string | null;
/** Validate the S3 configuration and derive every value the client needs. */
export declare function normalizeS3Config(config: S3BackendConfig, storePath?: string): S3Settings;
/**
 * Credential-free destination string for the settings page.
 *
 * Never throws: an incomplete configuration must still render.
 */
export declare function describeS3Destination(config: Pick<S3BackendConfig, 'endpoint' | 'bucket' | 'prefix'>, storePath?: string): string;
/**
 * Create the S3-compatible storage backend.
 *
 * Construction performs no I/O; the first operation validates and connects.
 */
export declare function createS3Backend(config: S3BackendConfig, options: BackendOptions): SyncBackend;
