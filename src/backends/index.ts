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

import { DEFAULT_BRANCH, DEFAULT_STORE_PATH } from '../constants.js'
import { SyncError } from '../core/errors.js'
import { redactText } from '../core/redact.js'
import type { BackendConfig, BackendKind, GitBackendConfig, SyncBackend, SyncLogger } from '../types.js'
import { createGitBackend, describeGitDestination, normalizeBranchName, normalizeRepoUrlInput } from './git.js'
import { createS3Backend, describeS3Destination, normalizeS3Config } from './s3.js'
import { createWebdavBackend, describeWebdavDestination, normalizeWebdavUrl } from './webdav.js'

/** HTTPS credentials resolved just-in-time for the git backend. */
export interface GitTokenCredentials {
  username: string
  token: string
}

/** What every backend needs from the host. */
export interface BackendOptions {
  /** Absolute directory the git backend may use as its clone/work tree cache. */
  workDir: string
  /** Directory inside the backend holding the synchronized documents (`''` = root). */
  storePath: string
  /** Redacting logger; every backend logs through it. */
  logger: SyncLogger
  /**
   * Resolves the HTTPS token for `authMode: 'https-token'` from the environment
   * variable named in the configuration. Called per Git command, so a rotated
   * token is picked up without recreating the backend.
   */
  tokenProvider?: () => Promise<GitTokenCredentials | null>
  /** Optional directory the git backend copies overwritten work-tree files to. */
  backupDir?: string
}

/** Credential-free summary of one configured backend. */
export interface BackendDescription {
  kind: BackendKind
  /** Human-readable destination; contains no username, password, token or key. */
  destination: string
  /** Whether {@link SyncBackend.history} can return entries. */
  supportsHistory: boolean
}

/** Resolve the store directory, defaulting only when the option is absent. */
function resolveStorePath(storePath: string | undefined): string {
  if (storePath === undefined) return DEFAULT_STORE_PATH
  const trimmed = storePath.trim()
  if (trimmed === '' || trimmed === '.') return ''
  return trimmed
}

/** Validate the shared work directory for the git backend. */
function assertWorkDir(workDir: string | undefined): void {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    throw new SyncError('invalid-config', '缺少本地工作目录 / the local work directory is not configured')
  }
}

/** Validate a git configuration eagerly and build its description. */
export function describeGitConfiguration(
  config: GitBackendConfig,
  storePath: string,
): BackendDescription {
  // Throws `not-configured` / `invalid-config` with a redacted message.
  normalizeRepoUrlInput(config.repoUrl)
  if ((config.branch ?? '').trim() === '') {
    // An empty branch is allowed at runtime (the default applies), but the
    // description should still be honest about what would be used.
    normalizeBranchName(DEFAULT_BRANCH)
  } else {
    normalizeBranchName(config.branch)
  }
  return {
    kind: 'git',
    destination: describeGitDestination(config, storePath),
    supportsHistory: true,
  }
}

/**
 * Describe one backend configuration.
 *
 * @param config - backend configuration from the plugin settings.
 * @param storePath - optional store directory to append to the destination.
 * @throws {SyncError} `not-configured` when a required field is blank,
 *   `invalid-config` when a field is malformed.
 */
export function describeBackend(config: BackendConfig, storePath?: string): BackendDescription {
  const resolvedStorePath = resolveStorePath(storePath)
  if (config === null || typeof config !== 'object') {
    throw new SyncError('not-configured', '尚未选择存储后端 / no storage backend is configured')
  }
  switch (config.kind) {
    case 'git':
      return describeGitConfiguration(config, resolvedStorePath)
    case 'webdav': {
      normalizeWebdavUrl(config.url)
      return {
        kind: 'webdav',
        destination: describeWebdavDestination(config, resolvedStorePath),
        supportsHistory: false,
      }
    }
    case 's3': {
      normalizeS3Config(config)
      return {
        kind: 's3',
        destination: describeS3Destination(config, resolvedStorePath),
        supportsHistory: false,
      }
    }
    default: {
      const unknown = (config as { kind?: unknown }).kind
      throw new SyncError(
        'unsupported-backend',
        `不支持的存储后端 / unsupported storage backend: ${redactText(String(unknown))}`,
      )
    }
  }
}

/**
 * Create the backend selected by `config`.
 *
 * Construction validates the configuration but performs no network or file I/O;
 * the first {@link SyncBackend.read}, {@link SyncBackend.write},
 * {@link SyncBackend.history} or {@link SyncBackend.testConnection} call does.
 */
export function createBackend(config: BackendConfig, options: BackendOptions): SyncBackend {
  const logger = options.logger
  const storePath = resolveStorePath(options.storePath)
  if (logger === undefined || logger === null) {
    throw new SyncError('invalid-config', '缺少日志记录器 / the logger is not configured')
  }
  if (config === null || typeof config !== 'object') {
    throw new SyncError('not-configured', '尚未选择存储后端 / no storage backend is configured')
  }
  switch (config.kind) {
    case 'git': {
      assertWorkDir(options.workDir)
      describeGitConfiguration(config, storePath)
      return createGitBackend(config, { ...options, storePath })
    }
    case 'webdav': {
      describeBackend(config, storePath)
      return createWebdavBackend(config, { ...options, storePath })
    }
    case 's3': {
      describeBackend(config, storePath)
      return createS3Backend(config, { ...options, storePath })
    }
    default: {
      const unknown = (config as { kind?: unknown }).kind
      throw new SyncError(
        'unsupported-backend',
        `不支持的存储后端 / unsupported storage backend: ${redactText(String(unknown))}`,
      )
    }
  }
}

export { createGitBackend, createS3Backend, createWebdavBackend }
export { describeGitDestination, describeS3Destination, describeWebdavDestination }
export { formatCommitTrailers, parseCommitTrailers, parseHistoryLog } from './git.js'
export { computeWebdavRevision, parseMultistatus } from './webdav.js'
export { AWS_SIGNATURE_ALGORITHM, amzDateString, canonicalQueryString, canonicalUri, sha256Hex, signAwsV4, uriEncode } from './sigv4.js'
