/**
 * The local applier: turns one planned action into a change on this device.
 *
 * Every mutation goes through a supported seam rather than editing files
 * directly:
 *
 *  - plugins are installed, enabled and removed through `ctx.pluginManager`;
 *  - entry configuration is written through `ctx.configEditor`, which preserves
 *    comments and `!!js` expressions and applies the change through the Loader;
 *  - credentials are written through `ctx.credentials`.
 *
 * The filesystem is only touched where DSH exposes no service for it: the
 * settings-page fallback when `configEditor` is missing, and a profile patch
 * entry that does not exist locally yet. Those paths are marked as requiring a
 * restart, because nothing applied them to the running composition.
 * @module engine/apply
 */

import { dirname, join } from 'node:path'
import type {
  ActionOutcome,
  ConfigFileRecord,
  DshSectionValue,
  JsonObject,
  JsonValue,
  McpServerRecord,
  PlanAction,
  PluginConfigRecord,
  PluginRecord,
  ProviderRecord,
  SecretsEnvelope,
  SyncLogger,
} from '../types.js'
import { SyncError, errorMessage } from '../core/errors.js'
import { asJsonObject, sanitizeJson } from '../core/json.js'
import { sanitizeUrl } from '../core/redact.js'
import { readTextFile, writePrivateFile } from '../core/fs.js'
import { mergePatch, preserveMaskedValues, splitPatch, upsertBlock } from '../core/patch.js'
import { emitPatchEntry, type Emittable } from '../core/yaml.js'
import type { DshChangeResult, DshConfigEditor, DshCredentials, DshLoaderEntry, DshPluginManager } from '../dsh.js'
import { decryptSecrets } from './crypto.js'
import { asConfigFile, asMcpRecord, asPluginConfigRecord, asPluginRecord, asProviderRecord } from './sections.js'
import { writeSecrets } from '../collect/secrets.js'

/** Services and paths the applier needs. */
export interface ApplierOptions {
  dshHome: string
  profile: string
  /** Absolute profile directory. */
  profileDir: string
  logger: SyncLogger
  pluginManager?: DshPluginManager | undefined
  configEditor?: DshConfigEditor | undefined
  credentials?: DshCredentials | undefined
  /** Passphrase for restoring the encrypted secret slice, when configured. */
  passphrase?: string | undefined
  env?: NodeJS.ProcessEnv
  /** Whether a change needs a DSH restart to take effect. */
  setRestartRequired?: (reason: string) => void
}

/** Per-action execution options. */
export interface ApplyOptions {
  /** Baseline value of the item, for a safe document merge. */
  base?: JsonValue
}

/** Applies one plan action to this device. */
export interface Applier {
  apply(action: PlanAction, options?: ApplyOptions): Promise<ActionOutcome>
}

/** Create the local applier for one profile. */
export function createApplier(options: ApplierOptions): Applier {
  const logger = options.logger

  const apply = async (action: PlanAction, applyOptions: ApplyOptions = {}): Promise<ActionOutcome> => {
    try {
      const detail = await dispatch(action, applyOptions)
      return { action, ok: true, ...(detail === undefined ? {} : { detail }) }
    } catch (error) {
      const syncError = error instanceof SyncError ? error : new SyncError('internal', errorMessage(error))
      if (syncError.code === 'unsupported') {
        logger.warn(`跳过不受支持的操作 / skipping an unsupported action: ${action.kind} ${action.name}`, {
          reason: syncError.message,
        })
        return { action, ok: true, skipped: true, detail: syncError.message }
      }
      logger.error(`本地应用失败 / local apply failed: ${action.kind} ${action.name}: ${syncError.message}`)
      return { action, ok: false, error: syncError.message }
    }
  }

  const dispatch = async (action: PlanAction, applyOptions: ApplyOptions): Promise<string | undefined> => {
    switch (action.kind) {
      case 'install-plugin':
      case 'upgrade-plugin':
      case 'downgrade-plugin':
        return installPlugin(action)
      case 'enable-plugin':
      case 'disable-plugin':
        return setPluginEnabled(action)
      case 'remove-plugin':
        return removePlugin(action)
      case 'write-plugin-config':
        return writePluginConfig(action)
      case 'write-provider':
        return writeProvider(action)
      case 'write-mcp':
        return writeMcp(action)
      case 'write-dsh-config':
        return writeDshConfig(action, applyOptions)
      case 'write-secret':
        return writeSecret(action)
      // Push actions never touch this device; the engine owns the store write.
      case 'push-plugin':
      case 'push-plugin-config':
      case 'push-provider':
      case 'push-dsh-config':
      case 'push-mcp':
      case 'push-secret':
      case 'remove-remote-item':
        return 'store-side action'
      default:
        throw new SyncError('unsupported', `未知操作 / unknown action: ${String(action.kind)}`)
    }
  }

  /** Install or change the version of one plugin. */
  const installPlugin = async (action: PlanAction): Promise<string> => {
    const manager = options.pluginManager
    if (manager === undefined) throw new SyncError('unsupported', '当前环境没有插件管理服务 / no plugin manager service')
    const plugin = asPluginRecord(action.value ?? null)
    if (plugin === null) throw new SyncError('invalid-config', '插件记录无效 / invalid plugin record')
    if (plugin.builtIn || plugin.origin === 'official') {
      return '内置插件由 DSH 提供，无需安装 / provided by DSH, nothing to install'
    }
    if (plugin.installSpec === null || plugin.installSpec.trim() === '') {
      throw new SyncError(
        'unsupported',
        `${plugin.name} 没有可复现的安装来源，请在设置页手动安装 / no reproducible install spec for ${plugin.name}`,
      )
    }
    if (plugin.origin === 'local-path' && plugin.restorable === false) {
      throw new SyncError(
        'unsupported',
        `${plugin.name} 是本地目录插件，不复制代码，请在目标设备本地安装 / a local-directory plugin is not copied`,
      )
    }
    const installed = await findInstalled(manager, plugin.name)
    if (installed !== null && installed.version === plugin.version && plugin.version !== null) {
      const enabled = await ensureEnabled(action, installed.moduleName, plugin.enabled)
      return `已安装 ${plugin.name}@${plugin.version}${enabled}`
    }
    let result = await manager.installBundle(plugin.installSpec, {
      enabled: plugin.enabled,
      saveExact: true,
    })
    if (result.application === 'failed' && result.error?.code === 'already-installed') {
      // DSH refuses to install over an installed name; replace it deliberately.
      const removal = await manager.removeBundle(plugin.name)
      if (removal.application === 'failed') {
        throw new SyncError('unsupported', `无法替换已安装插件 / cannot replace the installed plugin: ${removal.error?.diagnostic ?? ''}`)
      }
      result = await manager.installBundle(plugin.installSpec, { enabled: plugin.enabled, saveExact: true })
    }
    if (result.application === 'failed') {
      throw new SyncError(
        'unsupported',
        `安装失败 / install failed: ${result.error?.code ?? 'unknown'} ${result.error?.diagnostic ?? ''}`.trim(),
      )
    }
    noteApplication(result)
    const enabled = await ensureEnabled(action, plugin.name, plugin.enabled)
    return `${plugin.name}${plugin.version === null ? '' : `@${plugin.version}`} ${result.application}${enabled}`
  }

  /** Make sure the installed plugin matches the synchronized enabled state. */
  const ensureEnabled = async (
    action: PlanAction,
    moduleName: string,
    enabled: boolean,
  ): Promise<string> => {
    const manager = options.pluginManager
    if (manager === undefined) return ''
    const rows = await listRows(manager, moduleName)
    if (rows.length === 0) return ''
    let changed = false
    for (const row of rows) {
      if (row.enabled === enabled) continue
      const result = await manager.setPluginEnabled(row.entryId, enabled)
      if (result.application === 'failed') {
        throw new SyncError('unsupported', `无法切换启用状态 / cannot change enablement: ${result.error?.diagnostic ?? ''}`)
      }
      noteApplication(result)
      changed = true
    }
    return changed ? (enabled ? '，已启用' : '，已停用') : ''
  }

  const setPluginEnabled = async (action: PlanAction): Promise<string> => {
    const manager = options.pluginManager
    if (manager === undefined) throw new SyncError('unsupported', '当前环境没有插件管理服务 / no plugin manager service')
    const enabled = action.enabled ?? action.kind === 'enable-plugin'
    const moduleName = action.installSpec ?? action.name
    const rows = await listRows(manager, moduleName)
    if (rows.length === 0) throw new SyncError('not-found', `未找到插件 / plugin not installed: ${moduleName}`)
    for (const row of rows) {
      const result = await manager.setPluginEnabled(row.entryId, enabled)
      if (result.application === 'failed') {
        throw new SyncError('unsupported', `无法切换启用状态 / cannot change enablement: ${result.error?.diagnostic ?? ''}`)
      }
      noteApplication(result)
    }
    return `${moduleName} → ${enabled ? 'enabled' : 'disabled'}`
  }

  const removePlugin = async (action: PlanAction): Promise<string> => {
    const manager = options.pluginManager
    if (manager === undefined) throw new SyncError('unsupported', '当前环境没有插件管理服务 / no plugin manager service')
    const plugin = asPluginRecord(action.value ?? null)
    const name = plugin?.name ?? action.name
    const result = await manager.removeBundle(name)
    if (result.application === 'failed') {
      throw new SyncError('unsupported', `移除失败 / remove failed: ${result.error?.diagnostic ?? ''}`)
    }
    noteApplication(result)
    return `已移除 / removed ${name}`
  }

  /** Write the primary entry's configuration for one plugin. */
  const writePluginConfig = async (action: PlanAction): Promise<string> => {
    const record = asPluginConfigRecord(action.value ?? null)
    if (record === null) throw new SyncError('invalid-config', '插件配置记录无效 / invalid plugin config record')
    const entryId = record.entryIds[0]
    if (entryId === undefined) throw new SyncError('invalid-config', `插件 ${record.moduleName} 没有可写入的条目 / no entry to write`)
    const removed = await writeEntryConfig(entryId, record.moduleName, record.values, record.redacted)
    const suffix = removed.length === 0 ? '' : `（保留本地敏感字段 / kept local secret keys: ${removed.join(', ')}）`
    return `${record.moduleName} 配置已写入 / configuration written${suffix}`
  }

  /** Write one provider declaration into its hosting LLM entry. */
  const writeProvider = async (action: PlanAction): Promise<string> => {
    const provider = asProviderRecord(action.value ?? null)
    if (provider === null) throw new SyncError('invalid-config', 'provider 记录无效 / invalid provider record')
    const editor = options.configEditor
    if (editor === undefined) {
      throw new SyncError('unsupported', '当前环境没有配置编辑服务 / no config editor service')
    }
    const entries = editor.entries()
    const target =
      entries.find(entry => entry.id === provider.entryId) ??
      entries.find(entry => {
        const providers = asJsonObject(entry.config?.providers ?? null)
        return providers !== null && provider.id in providers
      }) ??
      entries.find(entry => typeof entry.name === 'string' && entry.name.includes('llm'))
    if (target === undefined) {
      throw new SyncError('unsupported', '找不到声明模型 provider 的条目 / no LLM entry declares providers')
    }
    await editor.edit(target, current => {
      const providers = asJsonObject(current.providers ?? null) ?? {}
      const next: JsonObject = { ...providers }
      next[provider.id] = providerToConfig(provider)
      return { ...current, providers: sanitizeJson(next) }
    })
    options.setRestartRequired?.('provider configuration applied through the Loader')
    return `${provider.id} → ${provider.displayName ?? provider.id}`
  }

  /** Write one MCP server definition as its own Loader entry. */
  const writeMcp = async (action: PlanAction): Promise<string> => {
    const server = asMcpRecord(action.value ?? null)
    if (server === null) throw new SyncError('invalid-config', 'MCP 记录无效 / invalid MCP record')
    const config = mcpToConfig(server)
    const editor = options.configEditor
    if (editor !== undefined) {
      const entries = editor.entries()
      const existing =
        entries.find(entry => entry.id === server.entryId) ??
        entries.find(entry => {
          const candidate = asJsonObject(entry.config ?? null)
          return candidate !== null && candidate.serverName === server.serverName
        })
      if (existing !== undefined) {
        await editor.edit(existing, current => ({ ...current, ...config }))
        options.setRestartRequired?.('MCP configuration applied through the Loader')
        return `${server.serverName} 已更新 / updated`
      }
    }
    // A brand-new entry has no Loader target, so it is inserted into the patch;
    // the Loader picks it up on the next composition (a restart).
    const entryId = safeEntryId(server.entryId === '' ? `mcp-${server.serverName}` : server.entryId)
    await insertPatchEntry(entryId, config)
    options.setRestartRequired?.(`MCP entry ${entryId} inserted into the profile patch`)
    return `${server.serverName} 需要重启后生效 / restart required`
  }

  /** Write one configuration file, merging per entry for patch documents. */
  const writeDshConfig = async (action: PlanAction, applyOptions: ApplyOptions): Promise<string> => {
    const file = asConfigFile(action.value ?? null)
    if (file === null) throw new SyncError('invalid-config', '配置文件记录无效 / invalid config file record')
    const remote = file as ConfigFileRecord
    let content = remote.content
    if (remote.kind === 'profile-patch' || remote.kind === 'home-patch') {
      const targetPath = join(options.dshHome, ...remote.path.split('/'))
      const current = (await readTextFile(targetPath)) ?? ''
      const base = asConfigFile(applyOptions.base ?? null)
      content = mergePatchText(current, remote, base)
      // Values the collector masked must not overwrite the ones this device
      // already has; anything still masked had no local value to keep.
      const masked = preserveMaskedValues(current, content)
      content = masked.text
      if (content === current) return `${remote.path} 已是最新 / already up to date`
      await writePrivateFile(targetPath, content)
      options.setRestartRequired?.(`${remote.path} updated`)
      const kept = masked.restored.length === 0 ? '' : `，保留本地敏感值 / kept local secrets: ${masked.restored.join(', ')}`
      const missing =
        masked.unresolved.length === 0
          ? ''
          : `，${masked.unresolved.length} 个敏感值需手动补全（${masked.unresolved.join(', ')}）/ fill in ${masked.unresolved.length} masked value(s) manually`
      if (masked.unresolved.length > 0) {
        logger.warn(`恢复后仍有敏感值被掩码 / masked values remain after restore: ${remote.path}`, {
          keys: masked.unresolved,
        })
      }
      return `${remote.path} 已合并 / merged${kept}${missing}`
    }
    if (remote.kind === 'profile-package') {
      const targetPath = join(options.profileDir, 'package.json')
      const current = (await readTextFile(targetPath)) ?? null
      content = mergePackageText(current, remote, asConfigFile(applyOptions.base ?? null))
      if (current === content) return 'package.json 已是最新 / already up to date'
      await writePrivateFile(targetPath, content)
      options.setRestartRequired?.('profile package.json updated')
      return 'package.json 已合并 / merged'
    }
    const targetPath = join(options.profileDir, 'cordis.yml')
    const current = (await readTextFile(targetPath)) ?? null
    if (current === content) return 'cordis.yml 已是最新 / already up to date'
    await writePrivateFile(targetPath, content)
    options.setRestartRequired?.('profile cordis.yml updated')
    return 'cordis.yml 已写入 / written'
  }

  /** Restore the encrypted secret slice. */
  const writeSecret = async (action: PlanAction): Promise<string> => {
    const envelope = action.value as SecretsEnvelope | undefined
    if (envelope === undefined || envelope === null) throw new SyncError('invalid-config', '密钥包无效 / invalid secret envelope')
    const passphrase = options.passphrase ?? ''
    const payload = await decryptSecrets(envelope, { passphrase })
    await writeSecrets(payload, {
      credentials: options.credentials,
      credentialsPath: join(options.dshHome, '.credentials.yaml'),
      logger,
    })
    return `已恢复 ${payload.refs.length} 个密钥引用 / restored ${payload.refs.length} secret references`
  }

  /**
   * Write an entry's configuration through the config editor.
   *
   * The synchronized record deliberately has no secret values (the collector
   * dropped them and reported their paths as `redacted`), so a wholesale
   * replace would delete a local API key that was never synchronized. The merge
   * below applies the synchronized values while keeping every local field the
   * record does not carry; the paths that were redacted are reported back so the
   * outcome can tell the user what stayed local.
   */
  const writeEntryConfig = async (
    entryId: string,
    moduleName: string,
    values: JsonObject,
    redacted: readonly string[] = [],
  ): Promise<string[]> => {
    const editor = options.configEditor
    if (editor === undefined) {
      throw new SyncError('unsupported', '当前环境没有配置编辑服务 / no config editor service')
    }
    const entry = editor.entries().find(candidate => candidate.id === entryId)
    if (entry === undefined) {
      throw new SyncError('not-found', `未找到条目 / entry not found: ${entryId} (${moduleName})`)
    }
    const kept: string[] = []
    await editor.edit(entry, current => {
      const merged: JsonObject = { ...(sanitizeJson(current) as JsonObject) }
      for (const [key, value] of Object.entries(sanitizeJson(values) as JsonObject)) {
        merged[key] = value
      }
      for (const path of redacted) {
        const root = path.split(/[.[]/)[0] ?? path
        if (root in current) kept.push(root)
      }
      return merged
    })
    options.setRestartRequired?.('entry configuration applied through the Loader')
    return [...new Set(kept)]
  }

  /** Insert or replace one entry in the active profile patch. */
  const insertPatchEntry = async (entryId: string, config: JsonObject): Promise<void> => {
    const patchPath = join(options.profileDir, 'cordis.patch.yml')
    const current = (await readTextFile(patchPath)) ?? '[]\n'
    const existing = splitPatch(current).blocks.find(block => block.id === entryId)
    const entry: { [key: string]: Emittable } =
      existing === undefined
        ? { id: entryId, name: MCP_ENTRY_MODULE, config: config as unknown as Emittable }
        : { id: entryId, config: config as unknown as Emittable }
    const next = upsertBlock(current, entryId, entry)
    await writePrivateFile(patchPath, next)
  }

  /** Record whether a plugin-manager change needs a restart. */
  const noteApplication = (result: DshChangeResult): void => {
    if (result.application === 'restart-required') {
      options.setRestartRequired?.(result.restartReason ?? 'plugin change needs a restart')
    }
  }

  return { apply }
}

/** Module name of the MCP client entry this plugin writes. */
const MCP_ENTRY_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Find one installed plugin by module name. */
async function findInstalled(
  manager: DshPluginManager,
  moduleName: string,
): Promise<{ entryId: string; moduleName: string; version: string | null; enabled: boolean } | null> {
  const plugins = await manager.listPlugins()
  const match = plugins.find(plugin => plugin.moduleName === moduleName)
  if (match === undefined) return null
  const bundles = await manager.listBundles().catch(() => [])
  const bundle = bundles.find(candidate => candidate.name === moduleName)
  return {
    entryId: match.entryId,
    moduleName: match.moduleName,
    version: bundle?.version ?? null,
    enabled: match.enabled,
  }
}

/** Every Loader row that belongs to one module. */
async function listRows(
  manager: DshPluginManager,
  moduleName: string,
): Promise<Array<{ entryId: string; enabled: boolean }>> {
  const plugins = await manager.listPlugins()
  return plugins
    .filter(plugin => plugin.moduleName === moduleName)
    .map(plugin => ({ entryId: plugin.entryId, enabled: plugin.enabled }))
}

/** Turn a provider record back into the configuration object it came from. */
export function providerToConfig(provider: ProviderRecord): JsonObject {
  const config: JsonObject = { ...provider.extra }
  if (provider.displayName !== undefined) config.displayName = provider.displayName
  if (provider.api !== undefined) config.api = provider.api
  if (provider.baseURL !== undefined) config.baseURL = provider.baseURL
  if (provider.apiKeyEnv !== undefined) config.apiKeyEnv = provider.apiKeyEnv
  config.models = provider.models.map(id => ({ id, name: id }))
  return sanitizeJson(config) as JsonObject
}

/** Turn an MCP record back into the entry configuration it came from. */
export function mcpToConfig(server: McpServerRecord): JsonObject {
  const config: JsonObject = { ...server.config }
  config.serverName = server.serverName
  config.transport = server.transport === 'unknown' ? 'stdio' : server.transport
  if (server.command !== undefined) config.command = server.command
  if (server.args.length > 0) config.args = [...server.args]
  if (server.cwd !== undefined) config.cwd = server.cwd
  if (server.url !== undefined) config.url = server.url
  return sanitizeJson(config) as JsonObject
}

/** Merge a remote patch file into the local text without dropping local entries. */
export function mergePatchText(
  localText: string,
  remote: ConfigFileRecord,
  base: ConfigFileRecord | null,
): string {
  const remoteIds = new Set<string>()
  for (const block of splitPatch(remote.content).blocks) {
    if (block.id !== null) remoteIds.add(block.id)
    for (const id of block.insertIds) remoteIds.add(id)
  }
  if (remoteIds.size === 0) return remote.content
  if (base === null) {
    // First pull: adopt every remote entry, keep any local-only block.
    return mergePatch(localText, remote.content, { takeIds: [...remoteIds] }).text
  }
  const baseMap = new Map<string, string>()
  for (const block of splitPatch(base.content).blocks) {
    if (block.id !== null) baseMap.set(block.id, block.text)
    for (const id of block.insertIds) baseMap.set(id, block.text)
  }
  const localMap = new Map<string, string>()
  for (const block of splitPatch(localText).blocks) {
    if (block.id !== null) localMap.set(block.id, block.text)
    for (const id of block.insertIds) localMap.set(id, block.text)
  }
  const remoteMap = new Map<string, string>()
  for (const block of splitPatch(remote.content).blocks) {
    if (block.id !== null) remoteMap.set(block.id, block.text)
    for (const id of block.insertIds) remoteMap.set(id, block.text)
  }
  const take: string[] = []
  for (const id of remoteIds) {
    const remoteText = remoteMap.get(id)
    if (remoteText === undefined) continue
    const baseText = baseMap.get(id)
    const localTouched = localMap.get(id) !== baseText
    // A locally modified entry stays local; the conflict resolution path decides
    // it explicitly, so silently overwriting here would lose that work.
    if (localTouched) continue
    if (remoteText !== baseText) take.push(id)
  }
  if (take.length === 0) return localText
  return mergePatch(localText, remote.content, { takeIds: take }).text
}

/** Merge a remote `package.json` into the local one, key by key. */
export function mergePackageText(localText: string | null, remote: ConfigFileRecord, base: ConfigFileRecord | null): string {
  const remoteDoc = parseObject(remote.content)
  if (remoteDoc === null) return remote.content
  const localDoc = localText === null ? null : parseObject(localText)
  if (localDoc === null) return remote.content
  const baseDoc = base === null ? null : parseObject(base.content)
  const merged: JsonObject = { ...localDoc }

  // dependencies: take remote-only/changed specs, keep local-only ones.
  const localDeps = asJsonObject(localDoc.dependencies ?? null) ?? {}
  const remoteDeps = asJsonObject(remoteDoc.dependencies ?? null) ?? {}
  const baseDeps = baseDoc === null ? null : asJsonObject(baseDoc.dependencies ?? null) ?? {}
  const deps: JsonObject = { ...localDeps }
  for (const [name, spec] of Object.entries(remoteDeps)) {
    const baseSpec = baseDeps === null ? undefined : baseDeps[name]
    const localSpec = localDeps[name]
    if (baseDeps !== null && localSpec !== baseSpec && localSpec !== undefined) continue
    if (localSpec === spec) continue
    if (baseDeps !== null && spec === baseSpec) continue
    deps[name] = spec
  }
  merged.dependencies = deps

  // dsh.profile.bundles: union, remote order first for remote additions.
  const localBundles = readBundles(localDoc)
  const remoteBundles = readBundles(remoteDoc)
  const bundles = [...localBundles]
  for (const bundle of remoteBundles) {
    if (!bundles.includes(bundle)) bundles.push(bundle)
  }
  const dsh = asJsonObject(merged.dsh ?? null) ?? {}
  const profile = asJsonObject(dsh.profile ?? null) ?? {}
  dsh.profile = { ...profile, bundles: sanitizeJson(bundles) }
  merged.dsh = dsh
  return `${JSON.stringify(merged, null, 2)}\n`
}

function readBundles(doc: JsonObject): string[] {
  const dsh = asJsonObject(doc.dsh ?? null)
  const profile = dsh === null ? null : asJsonObject(dsh.profile ?? null)
  const bundles = profile === null ? null : profile.bundles
  return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : []
}

function parseObject(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return asJsonObject(parsed)
  } catch {
    return null
  }
}

/** Keep an entry id valid for a patch row. */
function safeEntryId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? `mcp-${Date.now()}` : cleaned
}

/** Exported for the settings page: a one-line destination description. */
export function describeDestination(kind: string, destination: string): string {
  return `${kind}: ${sanitizeUrl(destination)}`
}

/** Exported for tests: the raw YAML of one inserted entry. */
export function entryYaml(entry: { id: string; name: string; config: JsonObject }): string {
  return emitPatchEntry({ id: entry.id, name: entry.name, config: entry.config })
}

/** Re-exported so callers do not need to know the module layout. */
export type { DshLoaderEntry }
