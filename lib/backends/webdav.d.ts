/**
 * WebDAV storage backend.
 *
 * The store is one WebDAV collection (plus nested collections for section
 * documents). Everything is driven by four verbs:
 *
 * - `PROPFIND` with `Depth: 1`, walked level by level. `Depth: infinity` is
 *   deliberately never used: many servers (and every reverse proxy worth its
 *   name) reject it, and a level-by-level walk also gives per-collection
 *   failure handling for free.
 * - `GET` for documents,
 * - `PUT` / `DELETE` for writes,
 * - `MKCOL` for the collections a write needs.
 *
 * **Revision model.** Object stores have no commit id, so the revision is a
 * SHA-256 over the sorted `(path, content digest)` pairs of the whole store.
 * It is therefore a pure function of what was read: two devices that see the
 * same documents compute the same revision, and an external writer changes it.
 *
 * **Concurrency.** A write compares the caller's `expectedRevision` with the
 * revision this backend read, and sends `If-Match` with the strong ETag the
 * server reported for each document it replaces (or `If-None-Match: *` for a
 * new document). A `412 Precondition Failed` is surfaced as
 * {@link SyncError} code `conflict`, never retried here: only the engine can
 * merge another device's changes safely.
 *
 * Credentials are sent as an `Authorization` header built from the local
 * configuration; they never appear in a URL, a log line or an error message.
 * @module backends/webdav
 */
import type { SyncBackend, WebdavBackendConfig } from '../types.js';
import type { BackendOptions } from './index.js';
/** Per-request timeout in milliseconds. */
export declare const WEBDAV_TIMEOUT_MS = 60000;
/** Parse one `multistatus` document into its entries. */
export declare function parseMultistatus(xml: string): Array<{
    href: string;
    isCollection: boolean;
    etag?: string;
    size?: number;
}>;
/** Compute the store revision over a path → content-digest map. */
export declare function computeWebdavRevision(digests: ReadonlyMap<string, string>): string | null;
/**
 * Validate a WebDAV collection URL.
 *
 * @throws {SyncError} `not-configured` when blank, `invalid-config` when not an
 *   http(s) URL or when it embeds credentials.
 */
export declare function normalizeWebdavUrl(raw: string): URL;
/**
 * Credential-free destination string for the settings page.
 *
 * Never throws: an incomplete configuration must still render.
 */
export declare function describeWebdavDestination(config: Pick<WebdavBackendConfig, 'url'>, storePath?: string): string;
/**
 * Create the WebDAV storage backend.
 *
 * Configuration is validated on first use, so the plugin can be constructed at
 * startup even when no backend is configured yet.
 */
export declare function createWebdavBackend(config: WebdavBackendConfig, options: BackendOptions): SyncBackend;
