/**
 * Typed client for the Host half's HTTP contract.
 *
 * The only wire knowledge this file has is `src/http/api-types.ts`, imported
 * with `import type` (plus the literal route prefix), so a contract change
 * breaks `tsc` instead of silently breaking the page.
 *
 * Wire rules:
 *  - every route is POSTed as JSON under {@link API_PREFIX};
 *  - the answer is the one {@link ApiEnvelope}: `{ ok: true, value }` or
 *    `{ ok: false, error: { code, message, details? } }`;
 *  - `error.message` is already localized by the Host and is shown verbatim, so
 *    a new Host message needs no client change.
 *
 * Mutating routes are two-phase: they reject with `confirmation-required` or
 * `conflict-present` and put the plan in `error.details.plan`. {@link planFromError}
 * exposes that plan to the confirmation dialog.
 * @module api
 */

import { API_PREFIX } from '../../src/http/api-types.js'
import type {
  ApiEnvelope,
  ApiRoute,
  AutoSyncRequest,
  AutoSyncResponse,
  BackupRequest,
  ConfigSaveRequest,
  ConfigSaveResponse,
  ConnectionTestRequest,
  ConnectionTestResponse,
  DiffRequest,
  DiffResponse,
  HistoryRequest,
  HistoryResponse,
  InventoryResponse,
  LogsRequest,
  LogsResponse,
  OperationResponse,
  PluginInspectRequest,
  PluginInspectResponse,
  RestorePreviewRequest,
  RestoreRequest,
  RollbackRequest,
  SecretsStatusResponse,
  SecretsUnlockRequest,
  SecretsUnlockResponse,
  SectionsListResponse,
  StatusRequest,
  SyncPreviewRequest,
  SyncRequest,
} from '../../src/http/api-types.js'
import type { StatusView, SyncPlan } from '../../src/types.js'

/** A failed Host call, carrying the Host's machine code and its display text. */
export class ApiRequestError extends Error {
  /** Machine-readable code from the Host envelope, or a transport code. */
  readonly code: string
  /** Structured details, when the Host sent any. */
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.details = details
  }
}

/** Turn any thrown value into text fit for the page. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** How long a read-only Host call may take before the page reports a timeout. */
const DEFAULT_TIMEOUT_MS = 20_000

/** Mutations and plan previews touch the store, so they get a longer budget. */
const MUTATION_TIMEOUT_MS = 120_000

/** Per-call transport options. */
export interface PostOptions {
  /** Caller-owned cancellation, forwarded to `fetch`. */
  signal?: AbortSignal
  /** Override the request timeout; `0` disables it. */
  timeoutMs?: number
}

/** Build the cancellation error from the caller's signal. */
function abortError(signal: AbortSignal): ApiRequestError {
  const reason: unknown = signal.reason
  const message = reason instanceof Error && reason.message !== '' ? reason.message : '请求已取消 / request cancelled'
  return new ApiRequestError('aborted', message)
}

/** Structural check for the Host envelope. */
function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.ok === true) return 'value' in record
  if (record.ok === false) {
    const error = record.error
    return error !== null && typeof error === 'object' && !Array.isArray(error)
  }
  return false
}

/** Unwrap one envelope, turning a failure into an {@link ApiRequestError}. */
async function unwrap<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try {
    payload = (await response.json()) as unknown
  } catch {
    payload = null
  }

  if (isEnvelope(payload)) {
    if (payload.ok === true) return payload.value as T
    const failure = payload.error as { code?: unknown; message?: unknown; details?: unknown }
    const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'unknown'
    const message =
      typeof failure.message === 'string' && failure.message !== ''
        ? failure.message
        : `HTTP ${response.status} ${response.statusText}`.trim()
    throw new ApiRequestError(code, message, failure.details)
  }

  // A non-envelope body (HTML error page, empty 204, proxy page, ...).
  const label = `${response.status} ${response.statusText}`.trim()
  throw new ApiRequestError('bad-response', label === '' ? 'HTTP error' : `HTTP ${label}`)
}

/**
 * POST one route and unwrap the Host envelope.
 *
 * `credentials: 'include'` and `cache: 'no-store'` are deliberate: the call must
 * ride the page's authenticated same-origin channel and must never be answered
 * from the HTTP cache, because every route returns live state.
 */
export async function post<T>(route: ApiRoute, body: unknown = {}, options: PostOptions = {}): Promise<T> {
  const { signal } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (signal !== undefined && signal.aborted) throw abortError(signal)

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }
  const forwardAbort = (): void => controller.abort()
  signal?.addEventListener('abort', forwardAbort)

  try {
    let response: Response
    try {
      response = await fetch(`${API_PREFIX}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw new ApiRequestError('timeout', '请求超时 / request timed out')
      if (signal !== undefined && signal.aborted) throw abortError(signal)
      if (controller.signal.aborted) {
        throw new ApiRequestError('aborted', '请求已取消 / request cancelled')
      }
      throw new ApiRequestError('network', errorText(error))
    }
    return await unwrap<T>(response)
  } finally {
    if (timer !== null) clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

// ---------------------------------------------------------------------------
// Status and configuration
// ---------------------------------------------------------------------------

/** Current status: state, effective configuration, and per-section cards. */
export function getStatus(body: StatusRequest = {}, options: PostOptions = {}): Promise<StatusView> {
  return post<StatusView>('status', body, options)
}

/** Persist the whole configuration; the Host answers with the effective view. */
export function saveConfig(body: ConfigSaveRequest, options: PostOptions = {}): Promise<ConfigSaveResponse> {
  return post<ConfigSaveResponse>('config/save', body, options)
}

/** Check backend reachability, optionally with unsaved field values. */
export function testConnection(
  body: ConnectionTestRequest = {},
  options: PostOptions = {},
): Promise<ConnectionTestResponse> {
  return post<ConnectionTestResponse>('connection/test', body, options)
}

/** Re-read only the per-section cards. */
export function getSections(options: PostOptions = {}): Promise<SectionsListResponse> {
  return post<SectionsListResponse>('sections/list', {}, options)
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Metadata of the plugins, providers, MCP servers, and secrets of one profile. */
export function getInventory(options: PostOptions = {}): Promise<InventoryResponse> {
  return post<InventoryResponse>('inventory', {}, options)
}

// ---------------------------------------------------------------------------
// Preview and mutation
// ---------------------------------------------------------------------------

/** Preview the plan a diff would produce, without executing it. */
export function getDiff(body: DiffRequest = {}, options: PostOptions = {}): Promise<DiffResponse> {
  return post<DiffResponse>('diff', body, options)
}

/** Upload this device's state to the store. */
export function backup(body: BackupRequest = {}, options: PostOptions = {}): Promise<OperationResponse> {
  return post<OperationResponse>('backup', body, { timeoutMs: MUTATION_TIMEOUT_MS, ...options })
}

/** Preview what restoring the store would change locally. */
export function previewRestore(
  body: RestorePreviewRequest = {},
  options: PostOptions = {},
): Promise<DiffResponse> {
  return post<DiffResponse>('restore/preview', body, { timeoutMs: MUTATION_TIMEOUT_MS, ...options })
}

/** Apply a restore. */
export function restore(body: RestoreRequest = {}, options: PostOptions = {}): Promise<OperationResponse> {
  return post<OperationResponse>('restore', body, { timeoutMs: MUTATION_TIMEOUT_MS, ...options })
}

/** Preview a two-way sync. */
export function previewSync(body: SyncPreviewRequest = {}, options: PostOptions = {}): Promise<DiffResponse> {
  return post<DiffResponse>('sync/preview', body, { timeoutMs: MUTATION_TIMEOUT_MS, ...options })
}

/** Apply a two-way sync. */
export function sync(body: SyncRequest = {}, options: PostOptions = {}): Promise<OperationResponse> {
  return post<OperationResponse>('sync', body, { timeoutMs: MUTATION_TIMEOUT_MS, ...options })
}

// ---------------------------------------------------------------------------
// History, logs, secrets, plugin inspection
// ---------------------------------------------------------------------------

/** Recent revisions of the store. */
export function getHistory(body: HistoryRequest = {}, options: PostOptions = {}): Promise<HistoryResponse> {
  return post<HistoryResponse>('history', body, options)
}

/** Restore this device from one historical revision. */
export function rollback(body: RollbackRequest, options: PostOptions = {}): Promise<OperationResponse> {
  return post<OperationResponse>('rollback', body, { timeoutMs: MUTATION_TIMEOUT_MS, ...options })
}

/** Persist the automatic-sync settings; the Host answers with the saved config. */
export function saveAutoSync(body: AutoSyncRequest, options: PostOptions = {}): Promise<AutoSyncResponse> {
  return post<AutoSyncResponse>('auto-sync', body, options)
}

/** Recent Host log entries (already redacted by the Host). */
export function getLogs(body: LogsRequest = {}, options: PostOptions = {}): Promise<LogsResponse> {
  return post<LogsResponse>('logs', body, options)
}

/** Presence-only secret status: never a secret value. */
export function getSecretsStatus(options: PostOptions = {}): Promise<SecretsStatusResponse> {
  return post<SecretsStatusResponse>('secrets/status', {}, options)
}

/** Verify a passphrase against the stored envelope without storing it. */
export function unlockSecrets(
  body: SecretsUnlockRequest = {},
  options: PostOptions = {},
): Promise<SecretsUnlockResponse> {
  return post<SecretsUnlockResponse>('secrets/unlock', body, options)
}

/** Check whether an install spec could rebuild a plugin on another device. */
export function inspectPlugin(
  body: PluginInspectRequest,
  options: PostOptions = {},
): Promise<PluginInspectResponse> {
  return post<PluginInspectResponse>('plugin/inspect', body, options)
}

// ---------------------------------------------------------------------------
// Two-phase confirmation
// ---------------------------------------------------------------------------

/** Codes a mutating route uses to hand back the plan that needs a decision. */
const PLAN_ERROR_CODES = new Set(['confirmation-required', 'conflict-present'])

/** Structural check for a plan carried over the wire. */
function isSyncPlan(value: unknown): value is SyncPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  return (
    (plan.direction === 'push' || plan.direction === 'pull' || plan.direction === 'two-way') &&
    Array.isArray(plan.actions) &&
    Array.isArray(plan.conflicts) &&
    Array.isArray(plan.diffs) &&
    Array.isArray(plan.warnings)
  )
}

/**
 * The `SyncPlan` carried by a `confirmation-required` / `conflict-present`
 * failure, or null for any other error. The page renders that plan, then
 * retries with `confirmDestructive: true` and the user's `resolutions`.
 */
export function planFromError(error: unknown): SyncPlan | null {
  if (!(error instanceof ApiRequestError)) return null
  if (!PLAN_ERROR_CODES.has(error.code)) return null
  const details = error.details
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null
  const plan = (details as Record<string, unknown>).plan
  return isSyncPlan(plan) ? plan : null
}
