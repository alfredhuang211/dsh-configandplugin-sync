/**
 * Wire contract between the Host half and the browser half.
 *
 * Both halves import this one module, so a route name or payload shape can
 * never drift between them: the client's `post()` is typed by the same request
 * and response interfaces the Host handler implements.
 *
 * Every route is `POST` + JSON under {@link API_PREFIX} and answers with the
 * {@link ApiEnvelope} envelope, which the client parses once.
 * @module http/api-types
 */

import type {
  BackendKind,
  ConflictResolution,
  ConnectionTestResult,
  HistoryEntry,
  JsonObject,
  LogEntry,
  OperationResult,
  SectionId,
  StatusView,
  SyncConfig,
  SyncPlan,
} from '../types.js'

/** Prefix every route shares. Kept literal so the client can be built standalone. */
export const API_PREFIX = '/api/dsh-configandplugin-sync'

/** Successful envelope. */
export interface ApiOk<T> {
  ok: true
  value: T
}

/** One typed failure. */
export interface ApiError {
  code: string
  message: string
  details?: unknown
}

/** Failed envelope. */
export interface ApiFailure {
  ok: false
  error: ApiError
}

/** The one envelope every route returns. */
export type ApiEnvelope<T> = ApiOk<T> | ApiFailure

/** Route names, shared so a typo is a type error. */
export type ApiRoute =
  | 'status'
  | 'config/save'
  | 'connection/test'
  | 'sections/list'
  | 'inventory'
  | 'diff'
  | 'backup'
  | 'restore/preview'
  | 'restore'
  | 'sync/preview'
  | 'sync'
  | 'history'
  | 'rollback'
  | 'auto-sync'
  | 'logs'
  | 'secrets/status'
  | 'secrets/unlock'
  | 'plugin/inspect'

/** Request body for a status read. */
export interface StatusRequest {
  refresh?: boolean
}

/** Request body for saving the configuration. */
export interface ConfigSaveRequest {
  config: SyncConfig
}

/** Request body for a connectivity test. */
export interface ConnectionTestRequest {
  backendKind?: BackendKind
  config?: SyncConfig
}

/** Request body for a diff / preview. */
export interface DiffRequest {
  direction?: 'push' | 'pull' | 'two-way'
  profile?: string
}

/** Request body for `restore/preview`. */
export interface RestorePreviewRequest {
  profile?: string
  refresh?: boolean
}

/** Request body for `sync/preview`. */
export interface SyncPreviewRequest {
  profile?: string
  refresh?: boolean
}

/** Response of `diff`, `sync/preview` and `restore/preview`. */
export interface DiffResponse {
  plan: SyncPlan
  /** Store revision the remote side was read at. */
  revision: string | null
}

/** Request body for a backup. */
export interface BackupRequest {
  message?: string
  confirmDestructive?: boolean
  profile?: string
}

/** Request body for a restore. */
export interface RestoreRequest {
  resolutions?: ConflictResolution[]
  confirmDestructive?: boolean
  profile?: string
  /** Only restore these item ids (any section). */
  itemIds?: string[]
}

/** Request body for a two-way sync. */
export interface SyncRequest {
  resolutions?: ConflictResolution[]
  confirmDestructive?: boolean
  profile?: string
}

/** Request body for history. */
export interface HistoryRequest {
  limit?: number
}

/** Request body for rollback. */
export interface RollbackRequest {
  revision: string
  resolutions?: ConflictResolution[]
  confirmDestructive?: boolean
}

/** Request body for auto-sync. */
export interface AutoSyncRequest {
  enabled?: boolean
  mode?: 'two-way' | 'backup' | 'restore'
  intervalMinutes?: number
  startupDelayMs?: number
  onStartup?: boolean
  onPluginChange?: boolean
  debounceMs?: number
}

/** Response of `auto-sync`: the configuration after the change, with secrets blanked. */
export interface AutoSyncResponse {
  config: StatusView['config']
}

/** Request body for logs. */
export interface LogsRequest {
  limit?: number
}

/** Response of `logs`. */
export interface LogsResponse {
  entries: LogEntry[]
}

/** Response of `history`. */
export interface HistoryResponse {
  entries: HistoryEntry[]
}

/** Response of `config/save`. */
export interface ConfigSaveResponse {
  config: StatusView['config']
}

/** Response of `secrets/status`: presence only, never a value. */
export interface SecretsStatusResponse {
  /** Whether the backend holds an encrypted secret document. */
  stored: boolean
  /** When the stored envelope was produced. */
  createdAt?: string
  /** How many references it holds. */
  refCount?: number
  /** Whether a passphrase is available in this process. */
  passphraseAvailable: boolean
  /** Reference names configured on this device (no values). */
  localRefs: string[]
  /** Record keys stored on this device (no payloads). */
  localRecords: string[]
}

/** Request body for `secrets/unlock`: verifies the passphrase without storing it. */
export interface SecretsUnlockRequest {
  /** Optional explicit passphrase; omit to use the configured environment variable. */
  passphrase?: string
}

/** Response of `secrets/unlock`. */
export interface SecretsUnlockResponse {
  ok: boolean
  refCount: number
  createdAt: string
}

/** Request body for `plugin/inspect`. */
export interface PluginInspectRequest {
  spec: string
}

/** Response of `plugin/inspect`, narrowed for display. */
export interface PluginInspectResponse {
  accepted: boolean
  kind?: string
  name?: string
  version?: string
  reason?: string
}

/** Response of `sections/list`: the section cards of the status read. */
export interface SectionsListResponse {
  sections: StatusView['sections']
}

/** Inventory row of one installed plugin. Metadata only: no code is synchronized. */
export interface InventoryPluginRow {
  id: string
  name: string
  version: string | null
  origin: string
  enabled: boolean
  /** Reproducible install spec, or null when the plugin cannot be reinstalled. */
  installSpec: string | null
  /** False for a local-directory plugin, whose code is deliberately not copied. */
  restorable: boolean
  /** True for a bundle shipped with DSH. */
  builtIn: boolean
  /** Whether this plugin is inside a synchronized section at all. */
  syncable: boolean
}

/** Inventory row of one model provider. */
export interface InventoryProviderRow {
  id: string
  displayName?: string
  api?: string
  baseURL?: string
  models: number
}

/** Inventory row of one MCP server. */
export interface InventoryMcpRow {
  id: string
  serverName: string
  transport: string
  installMethod: string
  packageName?: string
  packageVersion?: string
  command?: string
  url?: string
  /** Header names only; values are secret material and never synchronized. */
  headerNames: string[]
  /** Environment variable names only, for the same reason. */
  envNames: string[]
  enabled: boolean
}

/** Inventory payload of one profile, rendered by the Plugins / MCP tabs. */
export interface InventoryResponse {
  profile: string
  plugins: InventoryPluginRow[]
  providers: InventoryProviderRow[]
  mcp: InventoryMcpRow[]
  secrets: { refs: number; records: number; encrypted: boolean }
  dsh: { files: number; entries: number; bundles: number }
  /** Plugins that carry synchronized configuration (the Host always sends it). */
  pluginConfigs?: number
  /** The profile's default model selection, when declared. */
  defaultModel?: { provider?: string; model?: string } | null
  /** Non-fatal findings from the scan, safe to display. */
  warnings?: string[]
}

/** Response of `backup`, `restore`, `sync` and `rollback`. */
export interface OperationResponse {
  result: OperationResult
}

/** Narrow a JSON object to a plain record, for request bodies. */
export type JsonRecord = JsonObject

/** The section ids the client may send; kept next to the wire types. */
export type WireSectionId = SectionId

/** Convenience: what `connection/test` answers. */
export type ConnectionTestResponse = ConnectionTestResult
