/**
 * Local persisted state: this plugin's own configuration and runtime baseline.
 *
 * Both documents live under `$DSH_HOME/dsh-configandplugin-sync/` with private
 * permissions. The configuration holds storage credentials (a WebDAV password,
 * an S3 secret key) because they have to be usable offline, so it is written
 * `0600` and never synchronized; the baseline holds only what the device last
 * agreed with the store, which is what makes a three-way merge possible.
 * @module state/store
 */

import { basename, join } from 'node:path'
import { hostname } from 'node:os'
import type {
  AutoSyncConfig,
  BackendKind,
  DeviceInfo,
  LocalState,
  SectionId,
  SectionScopes,
  SyncConfig,
} from '../types.js'
import { defaultScopes } from '../types.js'
import {
  DEFAULT_BRANCH,
  DEFAULT_PASSPHRASE_ENV,
  DEFAULT_STORE_PATH,
  DEFAULT_TOKEN_ENV,
  PACKAGE_NAME,
} from '../constants.js'
import { randomId } from '../core/hash.js'
import { parseJson, sanitizeJson } from '../core/json.js'
import { displayPath } from '../core/paths.js'
import { ensurePrivateDir, readTextFile, writePrivateFile } from '../core/fs.js'

/** Every path this plugin owns inside the DSH home. */
export interface StorePaths {
  /** `$DSH_HOME/dsh-configandplugin-sync` */
  dataDir: string
  /** The plugin's private configuration. */
  configPath: string
  /** The persisted runtime state and baseline. */
  statePath: string
  /** The append-only log file. */
  logPath: string
  /** Git work trees and scratch files. */
  workDir: string
  /** Temporary downloads and rollback snapshots. */
  tempDir: string
}

/** Resolve every path this plugin owns. */
export function resolveStorePaths(dshHome: string): StorePaths {
  const dataDir = join(dshHome, PACKAGE_NAME)
  return {
    dataDir,
    configPath: join(dataDir, 'config.json'),
    statePath: join(dataDir, 'state.json'),
    logPath: join(dataDir, 'sync.log'),
    workDir: join(dataDir, 'work'),
    tempDir: join(dataDir, 'tmp'),
  }
}

/** Create every private directory the plugin owns. */
export async function ensureStoreDirs(paths: StorePaths): Promise<void> {
  await ensurePrivateDir(paths.dataDir)
  await ensurePrivateDir(paths.workDir)
  await ensurePrivateDir(paths.tempDir)
}

/** Default automatic-sync policy: off, and conservative when switched on. */
export function defaultAutoSync(): AutoSyncConfig {
  return {
    enabled: false,
    mode: 'two-way',
    intervalMinutes: 30,
    startupDelayMs: 15_000,
    onStartup: true,
    onPluginChange: false,
    debounceMs: 5_000,
  }
}

/** Suggestions for the section switches, before a user edits them. */
export function defaultSectionScopes(): SectionScopes {
  return defaultScopes()
}

/** Built-in default configuration, valid before the user configures anything. */
export function defaultConfig(activeProfile: string, availableProfiles: readonly string[]): SyncConfig {
  return {
    backendKind: 'git',
    git: {
      kind: 'git',
      repoUrl: '',
      branch: DEFAULT_BRANCH,
      authMode: 'ssh',
      tokenEnvVar: DEFAULT_TOKEN_ENV,
      username: '',
    },
    webdav: {
      kind: 'webdav',
      url: '',
      username: '',
      password: '',
      token: '',
    },
    s3: {
      kind: 's3',
      endpoint: '',
      region: 'us-east-1',
      bucket: '',
      prefix: DEFAULT_STORE_PATH,
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      forcePathStyle: true,
    },
    profiles: uniqueProfiles([activeProfile, ...availableProfiles]),
    scopes: defaultSectionScopes(),
    passphraseEnvVar: DEFAULT_PASSPHRASE_ENV,
    excluded: { 'dsh-config': [], providers: [], plugins: [], 'plugin-configs': [], secrets: [], mcp: [] },
    autoSync: defaultAutoSync(),
    deviceName: defaultDeviceName(),
  }
}

/** The host name as a human device name, trimmed to a sane length. */
export function defaultDeviceName(): string {
  const name = hostname().trim()
  return name === '' ? 'DSH device' : name.slice(0, 64)
}

/** Stable device identity, generated once per DSH home. */
export function createDeviceInfo(options: {
  existing: DeviceInfo | null
  name: string
  dshVersion: string
  pluginVersion: string
}): DeviceInfo {
  const existing = options.existing
  const existingId = (existing?.id ?? '').trim()
  return {
    id: existingId !== '' ? existingId : `dev_${randomId().replace(/-/g, '').slice(0, 20)}`,
    name: options.name.trim() === '' ? options.name : options.name,
    platform: process.platform,
    arch: process.arch,
    dshVersion: options.dshVersion,
    pluginVersion: options.pluginVersion,
  }
}

/** Fresh runtime state for one device. */
export function defaultState(device: DeviceInfo): LocalState {
  return {
    schemaVersion: 1,
    device,
    lastSyncAt: null,
    lastRevision: null,
    lastOperation: null,
    lastError: null,
    baselines: {},
    conflicts: [],
    connection: null,
    autoSyncFailures: 0,
  }
}

/**
 * Normalize arbitrary JSON into a valid configuration.
 *
 * The settings page may send a partial or stale object (a field added by a
 * newer version, a backend block missing from an older client), so every field
 * is defaulted rather than trusted.
 */
export function normalizeConfig(
  input: unknown,
  activeProfile: string,
  availableProfiles: readonly string[],
): SyncConfig {
  const base = defaultConfig(activeProfile, availableProfiles)
  const raw = asRecord(input)
  if (raw === null) return base

  const backendKind = readBackendKind(raw.backendKind) ?? base.backendKind
  const git = asRecord(raw.git)
  const webdav = asRecord(raw.webdav)
  const s3 = asRecord(raw.s3)
  const scopes = asRecord(raw.scopes)
  const autoSync = asRecord(raw.autoSync)
  const excluded = asRecord(raw.excluded)

  const profiles = Array.isArray(raw.profiles)
    ? uniqueProfiles(raw.profiles.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))
    : base.profiles

  return {
    backendKind,
    git: {
      kind: 'git',
      repoUrl: readString(git?.repoUrl, base.git.repoUrl),
      branch: readString(git?.branch, base.git.branch).trim() || DEFAULT_BRANCH,
      authMode:
        git?.authMode === 'credential-helper' || git?.authMode === 'ssh' || git?.authMode === 'https-token'
          ? git.authMode
          : base.git.authMode,
      tokenEnvVar: readString(git?.tokenEnvVar, base.git.tokenEnvVar).trim(),
      username: readString(git?.username, base.git.username).trim(),
    },
    webdav: {
      kind: 'webdav',
      url: readString(webdav?.url, base.webdav.url).trim(),
      username: readString(webdav?.username, base.webdav.username),
      password: readString(webdav?.password, base.webdav.password),
      token: readString(webdav?.token, base.webdav.token),
    },
    s3: {
      kind: 's3',
      endpoint: readString(s3?.endpoint, base.s3.endpoint).trim().replace(/\/+$/, ''),
      region: readString(s3?.region, base.s3.region).trim() || 'us-east-1',
      bucket: readString(s3?.bucket, base.s3.bucket).trim(),
      prefix: readString(s3?.prefix, base.s3.prefix).trim().replace(/^\/+|\/+$/g, ''),
      accessKeyId: readString(s3?.accessKeyId, base.s3.accessKeyId).trim(),
      secretAccessKey: readString(s3?.secretAccessKey, base.s3.secretAccessKey),
      sessionToken: readString(s3?.sessionToken, base.s3.sessionToken),
      forcePathStyle: typeof s3?.forcePathStyle === 'boolean' ? s3.forcePathStyle : base.s3.forcePathStyle,
    },
    profiles: uniqueProfiles([activeProfile, ...profiles]),
    scopes: normalizeScopes(scopes, base.scopes),
    passphraseEnvVar: normalizeEnvName(raw.passphraseEnvVar, base.passphraseEnvVar),
    excluded: normalizeExcluded(excluded, base.excluded),
    autoSync: {
      enabled: typeof autoSync?.enabled === 'boolean' ? autoSync.enabled : base.autoSync.enabled,
      mode:
        autoSync?.mode === 'two-way' || autoSync?.mode === 'backup' || autoSync?.mode === 'restore'
          ? autoSync.mode
          : base.autoSync.mode,
      intervalMinutes: clampNumber(autoSync?.intervalMinutes, base.autoSync.intervalMinutes, 0, 24 * 60),
      startupDelayMs: clampNumber(autoSync?.startupDelayMs, base.autoSync.startupDelayMs, 0, 10 * 60_000),
      onStartup: typeof autoSync?.onStartup === 'boolean' ? autoSync.onStartup : base.autoSync.onStartup,
      onPluginChange:
        typeof autoSync?.onPluginChange === 'boolean' ? autoSync.onPluginChange : base.autoSync.onPluginChange,
      debounceMs: clampNumber(autoSync?.debounceMs, base.autoSync.debounceMs, 500, 5 * 60_000),
    },
    deviceName: readString(raw.deviceName, base.deviceName).trim().slice(0, 64) || defaultDeviceName(),
  }
}

/** Read the plugin configuration, falling back to defaults when absent or corrupt. */
export class ConfigStore {
  readonly path: string
  private readonly normalize: (input: unknown) => SyncConfig

  constructor(path: string, normalize: (input: unknown) => SyncConfig) {
    this.path = path
    this.normalize = normalize
  }

  async read(): Promise<SyncConfig> {
    const text = await readTextFile(this.path)
    if (text === null) return this.normalize(null)
    return this.normalize(parseJson<unknown>(text))
  }

  async write(config: SyncConfig): Promise<void> {
    const safe = this.normalize(sanitizeJson(config))
    await writePrivateFile(this.path, `${JSON.stringify(safe, null, 2)}\n`)
  }

  /** Display form of the directory. */
  get displayPath(): string {
    return displayPath(this.path)
  }
}

/** Read/write the local runtime state. */
export class StateStore {
  readonly path: string
  private readonly fresh: () => LocalState

  constructor(path: string, fresh: () => LocalState) {
    this.path = path
    this.fresh = fresh
  }

  async read(): Promise<LocalState> {
    const text = await readTextFile(this.path)
    if (text === null) return this.fresh()
    const parsed = parseJson<Partial<LocalState>>(text)
    if (parsed === null || typeof parsed !== 'object') return this.fresh()
    const base = this.fresh()
    return {
      ...base,
      ...parsed,
      schemaVersion: base.schemaVersion,
      device: { ...base.device, ...(parsed.device ?? {}) },
      baselines: parsed.baselines ?? base.baselines,
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : base.conflicts,
      autoSyncFailures: typeof parsed.autoSyncFailures === 'number' ? parsed.autoSyncFailures : 0,
    }
  }

  async write(state: LocalState): Promise<void> {
    const safe = sanitizeJson(state)
    await writePrivateFile(this.path, `${JSON.stringify(safe, null, 2)}\n`)
  }
}

/**
 * Normalize an environment-variable *name*.
 *
 * Only a POSIX shell identifier can name a variable; anything else (a value with
 * spaces, quotes, dashes, or a non-string) is replaced by the fallback so the
 * configuration cannot claim to reference something that can never resolve.
 *
 * This is a syntax check, not a secret check: a password that happens to look
 * like an identifier (`alfred130211`) is syntactically a valid name. The
 * settings page therefore labels the field as a *variable name* and warns when
 * the named variable is not set, which is what surfaces that mistake.
 */
export function normalizeEnvName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : fallback
}

/** Keep the profile list stable and free of duplicates. */
function uniqueProfiles(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizeScopes(raw: Record<string, unknown> | null, base: SectionScopes): SectionScopes {
  if (raw === null) return base
  return {
    dshConfig: typeof raw.dshConfig === 'boolean' ? raw.dshConfig : base.dshConfig,
    providers: typeof raw.providers === 'boolean' ? raw.providers : base.providers,
    plugins: typeof raw.plugins === 'boolean' ? raw.plugins : base.plugins,
    pluginConfigs: typeof raw.pluginConfigs === 'boolean' ? raw.pluginConfigs : base.pluginConfigs,
    secrets: typeof raw.secrets === 'boolean' ? raw.secrets : base.secrets,
    mcp: typeof raw.mcp === 'boolean' ? raw.mcp : base.mcp,
  }
}

function normalizeExcluded(
  raw: Record<string, unknown> | null,
  base: SyncConfig['excluded'],
): SyncConfig['excluded'] {
  const out: SyncConfig['excluded'] = { ...base }
  const sections: SectionId[] = ['dsh-config', 'providers', 'plugins', 'plugin-configs', 'secrets', 'mcp']
  for (const section of sections) {
    const value = raw?.[section]
    out[section] = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
      : base[section]
  }
  return out
}

function readBackendKind(value: unknown): BackendKind | null {
  return value === 'git' || value === 'webdav' || value === 's3' ? value : null
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** The profile directory for one profile name. */
export function profileDir(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile)
}

/** The file name (not path) of a profile. */
export function profileNameOf(dir: string): string {
  return basename(dir)
}
