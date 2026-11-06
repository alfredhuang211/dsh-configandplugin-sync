/**
 * Storage backend factory.
 *
 * The engine never imports a concrete backend: it asks this module for a
 * {@link SyncBackend} by configuration and stays unaware of Git, WebDAV or S3.
 * That seam is what makes the three interchangeable and the engine testable
 * with an in-memory implementation.
 *
 * Two entry points exist on purpose:
 *
 * - {@link createBackend} wires a usable backend (and may perform no I/O until
 *   an operation needs it, so constructing the plugin never fails at startup);
 * - {@link describeBackend} validates the configuration and reports the
 *   human-readable destination and history support **without any I/O**, for the
 *   settings page and the agent tools. It throws `not-configured` or
 *   `invalid-config` instead of returning a half-valid description.
 *
 * Neither function ever puts a credential into the returned destination.
 * @module backends/index
 */
import type { BackendConfig, BackendKind, GitBackendConfig, SyncBackend, SyncLogger } from '../types.js';
import { createGitBackend, describeGitDestination } from './git.js';
import { createS3Backend, describeS3Destination } from './s3.js';
import { createWebdavBackend, describeWebdavDestination } from './webdav.js';
/** HTTPS credentials resolved just-in-time for the git backend. */
export interface GitTokenCredentials {
    username: string;
    token: string;
}
/** What every backend needs from the host. */
export interface BackendOptions {
    /** Absolute directory the git backend may use as its clone/work tree cache. */
    workDir: string;
    /** Directory inside the backend holding the synchronized documents (`''` = root). */
    storePath: string;
    /** Redacting logger; every backend logs through it. */
    logger: SyncLogger;
    /**
     * Resolves the HTTPS token for `authMode: 'https-token'` from the environment
     * variable named in the configuration. Called per Git command, so a rotated
     * token is picked up without recreating the backend.
     */
    tokenProvider?: () => Promise<GitTokenCredentials | null>;
    /** Optional directory the git backend copies overwritten work-tree files to. */
    backupDir?: string;
}
/** Credential-free summary of one configured backend. */
export interface BackendDescription {
    kind: BackendKind;
    /** Human-readable destination; contains no username, password, token or key. */
    destination: string;
    /** Whether {@link SyncBackend.history} can return entries. */
    supportsHistory: boolean;
}
/** Validate a git configuration eagerly and build its description. */
export declare function describeGitConfiguration(config: GitBackendConfig, storePath: string): BackendDescription;
/**
 * Describe one backend configuration.
 *
 * @param config - backend configuration from the plugin settings.
 * @param storePath - optional store directory to append to the destination.
 * @throws {SyncError} `not-configured` when a required field is blank,
 *   `invalid-config` when a field is malformed.
 */
export declare function describeBackend(config: BackendConfig, storePath?: string): BackendDescription;
/**
 * Create the backend selected by `config`.
 *
 * Construction validates the configuration but performs no network or file I/O;
 * the first {@link SyncBackend.read}, {@link SyncBackend.write},
 * {@link SyncBackend.history} or {@link SyncBackend.testConnection} call does.
 */
export declare function createBackend(config: BackendConfig, options: BackendOptions): SyncBackend;
export { createGitBackend, createS3Backend, createWebdavBackend };
export { describeGitDestination, describeS3Destination, describeWebdavDestination };
export { formatCommitTrailers, parseCommitTrailers, parseHistoryLog } from './git.js';
export { computeWebdavRevision, parseMultistatus } from './webdav.js';
export { AWS_SIGNATURE_ALGORITHM, amzDateString, canonicalQueryString, canonicalUri, sha256Hex, signAwsV4, uriEncode } from './sigv4.js';
