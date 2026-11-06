/**
 * Structural types for the DeepSeek Harness host APIs this plugin uses.
 *
 * Deliberately structural: the plugin declares no runtime dependency on any
 * `@deepseek-ai/*` package, so it keeps loading when a Harness release moves an
 * internal module. Only the surface declared here is read, and every optional
 * member is feature-detected before use.
 *
 * The method lists were confirmed against the running DSH 0.2.2-rc.1 with
 * `cordis_inspect_query` (`Service`) rather than guessed.
 * @module dsh
 */

/** Anything the Host context exposes through `ctx.get(name)`. */
export type DshService = Record<string, unknown>

/** Minimal logging surface (`ctx.logger`). */
export interface DshLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Disposer returned by registration helpers. */
export type DshDisposer = () => void | Promise<void>

/** The subset of the Cordis plugin context this plugin touches. */
export interface DshContext {
  logger: DshLogger
  get(name: string): DshService | undefined
  inject(deps: readonly string[], callback: (ctx: DshContext) => void): DshDisposer
  effect(callback: () => DshDisposer | void, label?: string): DshDisposer
  on(event: string, callback: (...args: never[]) => void): DshDisposer
  timeout(callback: () => void, delayMs: number): DshDisposer
  interval(callback: () => void, delayMs: number): DshDisposer
  provide?(name: string, value: unknown): void
}

/** Localized text as the Host's plugin metadata accepts it. */
export type DshLocalizedText = string | { en: string; [locale: string]: string }

/** Display metadata a plugin or bundle may carry. */
export interface DshPluginMeta {
  title?: DshLocalizedText
  description?: DshLocalizedText
  icon?: string
  error?: string
}

/**
 * One Loader entry as read through the plugin manager.
 *
 * `entryId` is the identity accepted by `setPluginEnabled`; `moduleName` is the
 * installed package name, which is also what a backup records.
 */
export interface DshPluginInfo {
  entryId: string
  moduleName: string
  meta?: DshPluginMeta
  enabled: boolean
  fiberPhase?: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  diagnostic?: string
  patchId?: string
  readOnlyReason?: string
}

/** One row a bundle patch declares. */
export interface DshBundleRowInfo {
  rowId: string
  moduleName: string
  meta?: DshPluginMeta
  entryId?: string
}

/** A bundle as listed by the profile's plugin manager. */
export interface DshBundleInfo {
  name: string
  official: boolean
  availability: 'installation' | 'profile' | 'missing'
  installTarget?: { spec: string; version: string }
  version?: string
  meta?: DshPluginMeta
  description?: string
  enabled: boolean
  installed: boolean
  source?: string
  optional: boolean
  removable: boolean
  updatable?: boolean
  readOnlyReason?: string
  error?: { code: string; diagnostic?: string }
  rows: DshBundleRowInfo[]
  overrides: string[]
}

/** Package-manager diagnostics from a plugin-manager operation. */
export interface DshPackageResult {
  exitCode: number
  output: string
  truncated: boolean
  logPath: string
  kind?: string
  timedOut?: boolean
}

/** Outcome of `installBundle` / `removeBundle` / `setBundleEnabled` / `setPluginEnabled`. */
export interface DshChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  restartReason?: string
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: { code: string; diagnostic?: string }
  warnings?: string[]
  packageResult?: DshPackageResult
  bundle?: string
  version?: string
  pendingBuilds?: string[]
  approvedBuilds?: string[]
}

/** What `inspect()` reports about an install spec, before installing it. */
export type DshPluginSpecInspection =
  | {
      status: 'accepted'
      kind: 'registry' | 'path' | 'git' | 'tarball'
      name?: string
      version?: string
      description?: string
      bundle: boolean | null
      registry?: string | null
      host?: string
    }
  | { status: 'refused'; problem: string; reason: string; registries?: readonly string[] }

/**
 * `ctx.pluginManager` — the Host's supported path for installing, removing and
 * toggling plugins. Using it keeps this plugin compatible with DSH's own
 * lifecycle and reload rules instead of editing profile files behind its back.
 */
export interface DshPluginManager {
  listPlugins(): Promise<DshPluginInfo[]>
  listBundles(): Promise<DshBundleInfo[]>
  inspect(
    spec: string,
    options?: { registry?: string | null },
    signal?: AbortSignal,
  ): Promise<DshPluginSpecInspection>
  installBundle(
    spec: string,
    options?: {
      enabled?: boolean
      saveExact?: boolean
      requestId?: string
      approvedBuilds?: string[]
      registry?: string | null
    },
  ): Promise<DshChangeResult>
  removeBundle(name: string): Promise<DshChangeResult>
  setBundleEnabled(name: string, enabled: boolean): Promise<DshChangeResult>
  setPluginEnabled(id: string, enabled: boolean): Promise<DshChangeResult>
  listVersions?(name: string, options?: { registry?: string | null }, signal?: AbortSignal): Promise<unknown>
  registries?(): Promise<{ registry?: string | null; fallbackRegistries?: readonly string[] }>
}

/** One registered settings namespace as reported by the settings service. */
export interface DshSettingsDescriptor {
  ns: string
  autoGenerate: boolean
  schema: unknown
  value: unknown
  revision: number
  base?: unknown
  user?: unknown
  applies: 'live'
  secrets?: { path: string[]; set: boolean }[]
}

/** One path-addressed settings edit. */
export type DshSettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** `ctx.settings` — form projection and owner of the user settings document. */
export interface DshSettingsService {
  describe(options?: { redactSecrets?: boolean }): DshSettingsDescriptor[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly DshSettingsPathOp[], expectedRevision?: number): Promise<void>
  prepareDocument?(): Promise<string | undefined>
}

/** A Loader entry as returned by the config editor. */
export interface DshLoaderEntry {
  id: string
  name?: string
  patchId?: string
  config?: Record<string, unknown>
  disabled?: boolean
  [key: string]: unknown
}

/**
 * `ctx.configEditor` — persist complete raw configs through the Loader path.
 *
 * `edit` writes the active profile's patch and applies the change immediately,
 * preserving comments and `!!js` expressions outside the replaced values.
 */
export interface DshConfigEditor {
  entries(): DshLoaderEntry[]
  configuration(): Array<{
    entry: DshLoaderEntry
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }>
  edit(
    entry: DshLoaderEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** A provider-managed API key record: the key value or an environment mapping. */
export interface DshApiKeyRecord {
  readonly kind: 'api-key'
  readonly key?: string
  readonly env?: Readonly<Record<string, string>>
}

/** An opaque durable credential record owned by a plugin (an authorization grant). */
export interface DshGrantRecord {
  readonly kind: 'grant'
  readonly payload: unknown
}

/** One stored credential record. */
export type DshCredentialRecord = DshApiKeyRecord | DshGrantRecord

/** The credential seam, reduced to the operations this plugin uses. */
export interface DshCredentials {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  listRecords?(): Promise<readonly { key: string; kind: DshCredentialRecord['kind'] }[]>
  readRecord?(key: string): Promise<DshCredentialRecord | undefined>
  /** Serialized read-modify-write; returning `undefined` leaves the entry untouched. */
  modifyRecord?(
    key: string,
    mutate: (current: DshCredentialRecord | undefined) => Promise<DshCredentialRecord | undefined>,
  ): Promise<DshCredentialRecord | undefined>
  deleteRecord?(key: string): Promise<void>
}

/** `ctx.connection` fetch route registry used to serve the settings page. */
export interface DshConnection {
  fetch?: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): DshDisposer
  }
}

/** What a profile context reports about the running profile. */
export interface DshProfileContext {
  name?: string
  dir?: string
  installAnchor?: string
}

/** `ctx.tools` registry, reduced to `register`. */
export interface DshToolRegistry {
  register(definition: unknown): DshDisposer
}
