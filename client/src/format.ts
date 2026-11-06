/**
 * Presentation helpers shared by the tabs: dates, versions, revisions, counts,
 * backend destinations, and dictionary-key lookups for Host enum values.
 *
 * Everything here is pure and DOM-free so the decision logic stays unit
 * testable; the components only call these and render the result.
 * @module format
 */

import type {
  BackendKind,
  DiffKind,
  LogEntry,
  PlanActionKind,
  PluginOrigin,
  SectionId,
  SyncConfig,
  SyncState,
} from '../../src/types.js'

/** Visual tone shared by badges, banners, and status pills. */
export type Tone = 'idle' | 'success' | 'warn' | 'error'

/** Render an ISO timestamp in the browser's locale; `fallback` when absent. */
export function formatDateTime(iso: string | null | undefined, fallback: string): string {
  if (iso === null || iso === undefined || iso.trim() === '') return fallback
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * Group the integer part of a number with commas.
 *
 * Deliberately not `toLocaleString()`: tests and the page then agree on one
 * deterministic shape regardless of the browser locale.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const negative = value < 0
  const absolute = Math.abs(value)
  const text = absolute.toString()
  // Very large values stringify in exponent form; leave those alone.
  if (text.includes('e') || text.includes('E')) return negative ? `-${text}` : text
  const [integerPart = '0', fractionPart] = text.split('.')
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`
  return negative ? `-${body}` : body
}

/** Format a count, falling back when the Host reported no number. */
export function formatCount(value: number | null | undefined, fallback: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback
  return formatNumber(value)
}

/** Format an installed version; absent versions read as `fallback`. */
export function formatVersion(version: string | null | undefined, fallback: string): string {
  if (version === null || version === undefined) return fallback
  const trimmed = version.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Short form of a revision (Git commit or content hash) for dense rows. */
export function shortRevision(revision: string | null | undefined): string {
  if (revision === null || revision === undefined) return ''
  return revision.trim().slice(0, 8)
}

/** Formatted revision, or `fallback` when the Host reported none. */
export function formatRevision(revision: string | null | undefined, fallback: string): string {
  const short = shortRevision(revision)
  return short === '' ? fallback : short
}

/** Join a profile list for display; empty lists read as `fallback`. */
export function formatProfileList(profiles: readonly string[], fallback: string): string {
  const cleaned = profiles.map(profile => profile.trim()).filter(profile => profile !== '')
  return cleaned.length === 0 ? fallback : [...new Set(cleaned)].join(', ')
}

/** Join differing field names for display. */
export function formatFields(fields: readonly string[], fallback: string): string {
  const cleaned = fields.map(field => field.trim()).filter(field => field !== '')
  return cleaned.length === 0 ? fallback : cleaned.join(', ')
}

/**
 * The destination the header shows for the configured backend: a repository
 * URL for Git, a collection URL for WebDAV, and `s3://bucket/prefix` for S3.
 * Empty strings mean "not configured yet".
 */
export function formatBackendDestination(config: SyncConfig): string {
  switch (config.backendKind) {
    case 'git':
      return config.git.repoUrl.trim()
    case 'webdav':
      return config.webdav.url.trim()
    case 's3': {
      const bucket = config.s3.bucket.trim()
      if (bucket === '') return config.s3.endpoint.trim()
      const prefix = config.s3.prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '')
      return prefix === '' ? `s3://${bucket}` : `s3://${bucket}/${prefix}`
    }
    default:
      return ''
  }
}

/** Dictionary key for a synchronized section name. */
export function sectionLabelKey(section: SectionId): string {
  const keys: Record<SectionId, string> = {
    'dsh-config': 'sectionDshConfig',
    providers: 'sectionProviders',
    plugins: 'sectionPlugins',
    'plugin-configs': 'sectionPluginConfigs',
    secrets: 'sectionSecrets',
    mcp: 'sectionMcp',
  }
  return keys[section] ?? 'sectionDshConfig'
}

/** Dictionary key for a backend kind. */
export function backendLabelKey(kind: BackendKind): string {
  switch (kind) {
    case 'git':
      return 'backendGit'
    case 'webdav':
      return 'backendWebdav'
    case 's3':
      return 'backendS3'
    default:
      return 'backendGit'
  }
}

/** Dictionary key for a sync state pill. */
export function stateLabelKey(state: SyncState): string {
  const keys: Record<SyncState, string> = {
    'not-configured': 'stateNotConfigured',
    synced: 'stateSynced',
    ahead: 'stateAhead',
    behind: 'stateBehind',
    diverged: 'stateDiverged',
    conflict: 'stateConflict',
    error: 'stateError',
    syncing: 'stateSyncing',
    unknown: 'stateUnknown',
  }
  return keys[state] ?? 'stateUnknown'
}

/** Tone for a sync state pill. */
export function stateTone(state: SyncState): Tone {
  switch (state) {
    case 'synced':
      return 'success'
    case 'error':
      return 'error'
    case 'ahead':
    case 'behind':
    case 'diverged':
    case 'conflict':
      return 'warn'
    case 'not-configured':
    case 'syncing':
    case 'unknown':
    default:
      return 'idle'
  }
}

/** Tone for a log level. */
export function levelTone(level: LogEntry['level']): Tone {
  switch (level) {
    case 'error':
      return 'error'
    case 'warn':
      return 'warn'
    case 'debug':
    case 'info':
    default:
      return 'idle'
  }
}

/** Dictionary key for an operation name, or null for an unknown operation. */
export function operationLabelKey(operation: string | null | undefined): string | null {
  switch (operation) {
    case 'backup':
      return 'opBackup'
    case 'restore':
      return 'opRestore'
    case 'sync':
      return 'opSync'
    case 'rollback':
      return 'opRollback'
    default:
      return null
  }
}

/** Tone for a history row's result trailer. */
export function resultTone(result: string | null | undefined): Tone {
  if (result === null || result === undefined) return 'idle'
  switch (result.trim().toLowerCase()) {
    case 'ok':
    case 'success':
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'error':
    case 'failure':
      return 'error'
    default:
      return 'idle'
  }
}

/** Dictionary key for an item difference kind. */
export function diffKindLabelKey(kind: DiffKind): string {
  const keys: Record<DiffKind, string> = {
    identical: 'diffIdentical',
    'local-only': 'diffLocalOnly',
    'remote-only': 'diffRemoteOnly',
    changed: 'diffChanged',
    'deleted-remote': 'diffDeletedRemote',
    'deleted-local': 'diffDeletedLocal',
    unsupported: 'diffUnsupported',
  }
  return keys[kind] ?? 'diffUnsupported'
}

/** Dictionary key for a plan step kind. */
export function planKindLabelKey(kind: PlanActionKind): string {
  const keys: Record<PlanActionKind, string> = {
    'install-plugin': 'planKindInstallPlugin',
    'upgrade-plugin': 'planKindUpgradePlugin',
    'downgrade-plugin': 'planKindDowngradePlugin',
    'enable-plugin': 'planKindEnablePlugin',
    'disable-plugin': 'planKindDisablePlugin',
    'remove-plugin': 'planKindRemovePlugin',
    'write-plugin-config': 'planKindWritePluginConfig',
    'write-provider': 'planKindWriteProvider',
    'write-dsh-config': 'planKindWriteDshConfig',
    'write-mcp': 'planKindWriteMcp',
    'write-secret': 'planKindWriteSecret',
    'push-plugin': 'planKindPushPlugin',
    'push-plugin-config': 'planKindPushPluginConfig',
    'push-provider': 'planKindPushProvider',
    'push-dsh-config': 'planKindPushDshConfig',
    'push-mcp': 'planKindPushMcp',
    'push-secret': 'planKindPushSecret',
    'remove-remote-item': 'planKindRemoveRemoteItem',
  }
  return keys[kind] ?? 'planKindInstallPlugin'
}

/** Dictionary key for a plugin origin, falling back to the raw value's "unknown". */
export function originLabelKey(origin: string): string {
  const keys: Record<PluginOrigin, string> = {
    npm: 'originNpm',
    git: 'originGit',
    'local-path': 'originLocalPath',
    tarball: 'originTarball',
    official: 'originOfficial',
    unknown: 'originUnknown',
  }
  return keys[origin as PluginOrigin] ?? 'originUnknown'
}

/** Dictionary key for an MCP transport. */
export function transportLabelKey(transport: string): string {
  switch (transport) {
    case 'stdio':
      return 'transportStdio'
    case 'streamable-http':
      return 'transportStreamableHttp'
    case 'sse':
      return 'transportSse'
    default:
      return 'transportUnknown'
  }
}

/** Dictionary key for an MCP install method. */
export function installMethodLabelKey(method: string): string {
  switch (method) {
    case 'npx':
      return 'methodNpx'
    case 'uvx':
      return 'methodUvx'
    case 'pip':
      return 'methodPip'
    case 'npm':
      return 'methodNpm'
    case 'binary':
      return 'methodBinary'
    case 'http':
      return 'methodHttp'
    case 'docker':
      return 'methodDocker'
    default:
      return 'methodUnknown'
  }
}
