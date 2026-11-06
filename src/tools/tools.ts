/**
 * Agent tools.
 *
 * Every tool calls the same engine method the settings page calls — no
 * operation logic is duplicated here, and no tool builds a shell command.
 * Destructive work is two-phase for the model: without `confirm: true` a tool
 * returns the preview plan, and even with it the engine refuses unless the plan
 * was explicitly confirmed, so an agent cannot destroy data silently.
 * @module tools/tools
 */

import { SyncError, errorMessage } from '../core/errors.js'
import type { DshContext, DshDisposer } from '../dsh.js'
import type { SyncEngine } from '../engine/index.js'
import type { ConflictResolution, SectionId, SyncLogger } from '../types.js'

/** Minimal content block shape the tool registry accepts. */
interface TextContent {
  type: 'text'
  text: string
}

/** The structural tool definition `ctx.tools.register` accepts. */
interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextContent[]
  }
  timeoutMs?: number
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<unknown>
  isConcurrencySafe?: (args: unknown) => boolean
}

const SECTION_VALUES: readonly SectionId[] = [
  'dsh-config',
  'providers',
  'plugins',
  'plugin-configs',
  'secrets',
  'mcp',
]

/** Parameters shared by tools that can preview or execute. */
const CONFIRM_PARAMETER = {
  type: 'boolean',
  description:
    'Execute for real. Omit or false to receive a preview plan first. A plan that removes something additionally needs `confirmDestructive: true`.',
} as const

/** Conflict resolution parameter schema. */
const RESOLUTIONS_PARAMETER = {
  type: 'array',
  description: 'Decisions for the conflicts returned by a previous preview.',
  items: {
    type: 'object',
    properties: {
      section: { type: 'string', enum: [...SECTION_VALUES] },
      id: { type: 'string' },
      choice: { type: 'string', enum: ['local', 'remote', 'skip'] },
    },
    required: ['section', 'id', 'choice'],
    additionalProperties: false,
  },
} as const

/** Render a JSON value as the model-facing text block. */
function renderJson(_args: unknown, value: unknown): TextContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Project a tool result onto lossless JSON.
 *
 * The tool registry rejects a canonical value that is not lossless JSON, and
 * plans legitimately carry optional fields as explicit `undefined`. A JSON
 * round-trip drops exactly those keys; without it every preview tool would fail
 * at the boundary.
 */
function lossless(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** Read a boolean argument. */
function booleanArg(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Read a string argument. */
function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read a number argument. */
function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read conflict resolutions from unknown arguments. */
function resolutionsArg(value: unknown): ConflictResolution[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ConflictResolution[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id === '') continue
    if (!SECTION_VALUES.includes(raw.section as SectionId)) continue
    if (raw.choice !== 'local' && raw.choice !== 'remote' && raw.choice !== 'skip') continue
    out.push({ section: raw.section as SectionId, id: raw.id, choice: raw.choice })
  }
  return out.length === 0 ? undefined : out
}

/** Normalize a thrown error into a tool result rather than a tool crash. */
function errorResult(error: unknown): Record<string, unknown> {
  if (error instanceof SyncError) {
    const details = error.details as { plan?: unknown } | undefined
    if (error.code === 'confirmation-required' || error.code === 'conflict-present') {
      return lossless({
        ok: true,
        requiresConfirmation: true,
        needsUserDecision: true,
        reason: error.message,
        plan: details?.plan,
      }) as Record<string, unknown>
    }
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return { ok: false, error: { code: 'internal', message: errorMessage(error) } }
}

/** Build the agent tools. */
export function buildToolDefinitions(engine: SyncEngine): ToolDefinitionLike[] {
  return [
    {
      name: 'dsh_sync_status',
      description:
        'Show the DSH Config & Plugin Sync status: configured backend and destination, device, last sync time/revision, per-section local/remote/changed/conflict counts, pending uploads and downloads, and the last error. Use `refresh: true` to contact the storage backend. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Fetch the remote store before computing the status.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async args => {
        const raw = (args ?? {}) as Record<string, unknown>
        try {
          const status = await engine.status({ refresh: booleanArg(raw.refresh) === true })
          return lossless({
            ok: true,
            state: status.state,
            backend: status.config.backendKind,
            lastSyncAt: status.lastSyncAt,
            lastRevision: status.lastRevision,
            pendingUploads: status.pendingUploads,
            pendingDownloads: status.pendingDownloads,
            conflictCount: status.conflictCount,
            lastError: status.lastError,
            warnings: status.warnings,
            busy: status.busy,
            sections: status.sections,
          })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_inventory',
      description:
        'List what this device would synchronize: DSH configuration file count, model providers, post-installed plugins (name, version, origin, install spec, enabled, restorable), MCP servers (transport, install method, version) and secret reference names. DeepSeek official/built-in bundles are excluded from the plugin list and only counted. Read-only. No plugin code and no secret value is included.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async () => {
        try {
          return lossless({ ok: true, ...(await engine.inventory()) })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_diff',
      description:
        'Compare this device with the synchronized store without changing anything. direction "push" previews a backup, "pull" previews a restore, "two-way" previews a sync (default). Returns per-item differences, conflicts, warnings and the actions that would run.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['push', 'pull', 'two-way'], description: 'Which operation to preview.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async args => {
        const raw = (args ?? {}) as Record<string, unknown>
        const direction =
          raw.direction === 'push' || raw.direction === 'pull' || raw.direction === 'two-way' ? raw.direction : 'two-way'
        try {
          return lossless({ ok: true, ...(await engine.diff({ direction })) })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_backup',
      description:
        'Upload this device\'s DSH configuration, model providers, plugin inventory and configuration, MCP servers and (when enabled) the encrypted secret envelope to the configured store. Returns a preview plan unless `confirm: true` is set.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Optional short message stored with this write.' },
          confirm: CONFIRM_PARAMETER,
          confirmDestructive: {
            type: 'boolean',
            description: 'Allow the plan to record a removal (tombstone) in the store. Requires user agreement.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 300_000,
      isConcurrencySafe: () => false,
      execute: async args => {
        const raw = (args ?? {}) as Record<string, unknown>
        try {
          if (booleanArg(raw.confirm) !== true) {
            const preview = await engine.diff({ direction: 'push' })
            return lossless({
              ok: true,
              requiresConfirmation: preview.plan.actions.length > 0,
              plan: preview.plan,
              hint: 'Review the plan with the user, then call again with confirm: true.',
            })
          }
          const result = await engine.backup({
            message: stringArg(raw.message),
            confirmDestructive: booleanArg(raw.confirmDestructive) === true,
          })
          return lossless({ ok: true, result })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_restore',
      description:
        'Restore this device from the synchronized store: configuration, providers, plugins (installed through the DSH plugin manager), plugin configuration, MCP servers and secrets. Preview first (default), then execute with `confirm: true`. Restoring never deletes a plugin that the store does not know about, but a store tombstone is offered as a removal and needs `confirmDestructive: true`.',
      parameters: {
        type: 'object',
        properties: {
          resolutions: RESOLUTIONS_PARAMETER,
          confirm: CONFIRM_PARAMETER,
          confirmDestructive: { type: 'boolean', description: 'Allow removing local items the store marked as deleted.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 300_000,
      isConcurrencySafe: () => false,
      execute: async args => {
        const raw = (args ?? {}) as Record<string, unknown>
        try {
          if (booleanArg(raw.confirm) !== true) {
            const preview = await engine.previewRestore({})
            return lossless({
              ok: true,
              requiresConfirmation: preview.plan.actions.length > 0 || preview.plan.conflicts.length > 0,
              plan: preview.plan,
              hint: 'Review the plan and conflicts with the user, then call again with confirm: true and resolutions if needed.',
            })
          }
          const result = await engine.restore({
            resolutions: resolutionsArg(raw.resolutions),
            confirmDestructive: booleanArg(raw.confirmDestructive) === true,
          })
          return lossless({ ok: true, result })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_sync',
      description:
        'Two-way synchronize this device with the store: local-only changes are uploaded and remote-only changes are applied locally. Preview first (default) and execute with `confirm: true`. Conflicts are never resolved automatically; pass `resolutions` to decide them.',
      parameters: {
        type: 'object',
        properties: {
          resolutions: RESOLUTIONS_PARAMETER,
          confirm: CONFIRM_PARAMETER,
          confirmDestructive: { type: 'boolean', description: 'Allow removal actions in either direction.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 300_000,
      isConcurrencySafe: () => false,
      execute: async args => {
        const raw = (args ?? {}) as Record<string, unknown>
        try {
          if (booleanArg(raw.confirm) !== true) {
            const preview = await engine.previewSync({})
            return lossless({
              ok: true,
              requiresConfirmation: preview.plan.actions.length > 0 || preview.plan.conflicts.length > 0,
              plan: preview.plan,
              hint: 'Review the plan and conflicts with the user, then call again with confirm: true and resolutions if needed.',
            })
          }
          const result = await engine.sync({
            resolutions: resolutionsArg(raw.resolutions),
            confirmDestructive: booleanArg(raw.confirmDestructive) === true,
          })
          return lossless({ ok: true, result })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_history',
      description:
        'List recent writes of the synchronized store (git commits when the backend is Git, otherwise the recorded rollback snapshots) with time, device, operation and item count. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of entries to return (default 20, max 100).' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async args => {
        const raw = (args ?? {}) as Record<string, unknown>
        const limit = Math.min(100, Math.max(1, Math.round(numberArg(raw.limit) ?? 20)))
        try {
          const history = await engine.history({ limit })
          const snapshots = await engine.listSnapshots({})
          return lossless({ ok: true, entries: history.entries, snapshots: snapshots.slice(0, 20) })
        } catch (error) {
          return errorResult(error)
        }
      },
    },

    {
      name: 'dsh_sync_secrets_status',
      description:
        'Report secret synchronization state without exposing any value: whether the store holds an encrypted envelope and when it was written, whether a passphrase is available in this process, and which reference names and record keys exist locally.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async () => {
        try {
          return lossless({ ok: true, ...(await engine.secretsStatus({})) })
        } catch (error) {
          return errorResult(error)
        }
      },
    },
  ]
}

/** Register every tool on the context; returns a disposer removing them. */
export function registerTools(options: { ctx: DshContext; engine: SyncEngine; logger: SyncLogger }): DshDisposer {
  const tools = options.ctx.get('tools') as { register?: (definition: unknown) => DshDisposer } | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    options.logger.warn('当前 DSH 环境未注册 Agent 工具服务 / agent tool service unavailable')
    return () => undefined
  }
  const disposers: DshDisposer[] = []
  for (const definition of buildToolDefinitions(options.engine)) {
    try {
      disposers.push(tools.register(definition))
    } catch (error) {
      options.logger.error(`注册工具失败 / failed to register tool ${definition.name}: ${errorMessage(error)}`)
    }
  }
  options.logger.info(`已注册 ${disposers.length} 个 Agent 工具 / registered agent tools`)
  return () => {
    for (const disposer of disposers.splice(0)) {
      try {
        void disposer()
      } catch {
        // Owned by the plugin fiber anyway.
      }
    }
  }
}
