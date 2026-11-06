/**
 * Section semantics: how a snapshot turns into store items, how two sides are
 * compared, and how a conflict is merged.
 *
 * Everything that decides "is this changed?" or "is this a conflict?" lives
 * here so the plan builder, the applier and the UI all agree on one answer.
 * The comparison is a three-way merge against the local baseline: a change can
 * only be attributed to a device when the device's last agreed value is known,
 * which is why an unknown baseline makes both sides suspicious instead of
 * silently overwriting one.
 * @module engine/sections
 */

import { SECTION_IDS } from '../types.js'
import type {
  AnyRemoteSection,
  ConfigFileRecord,
  DshSectionValue,
  ItemDiff,
  JsonObject,
  JsonValue,
  McpServerRecord,
  PluginConfigRecord,
  PluginRecord,
  ProfileSnapshot,
  ProviderRecord,
  RemoteItem,
  SecretsEnvelope,
  SectionId,
  SyncPlan,
  PlanAction,
  ConflictInfo,
  ConflictResolution,
} from '../types.js'
import { sha256Json, sha256Text } from '../core/hash.js'
import { sanitizeJson, stableStringify } from '../core/json.js'
import { splitPatch, mergePatch } from '../core/patch.js'
import { compareVersions } from '../core/version.js'

/** One synchronizable item as this device sees it. */
export interface LocalItem {
  id: string
  name: string
  value: JsonValue
  hash: string
}

/** One item as the store sees it. */
export interface RemoteItemView {
  id: string
  name: string
  value: JsonValue
  hash: string
  deleted: boolean
  updatedAt: string
  updatedBy: string
}

/** Baseline view: the last value this device agreed with the store about. */
export interface BaselineItem {
  hash: string
  value: JsonValue
}

/** Coerce a record type into lossless JSON (all records in `types.ts` are JSON-shaped). */
export function toJson(value: unknown): JsonValue {
  return value as unknown as JsonValue
}

/**
 * Project a synchronized value onto the fields that must agree across devices.
 *
 * Some fields are device-local by nature — the Loader entry id a device
 * happened to assign, the OS, the profile — and comparing them would make two
 * correct devices look permanently different (and, with no baseline, produce a
 * conflict on every run). They are dropped from the comparison and the hash,
 * while the stored value keeps them so the UI can still show provenance.
 */
export function comparisonValue(section: SectionId, value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, JsonValue>
  switch (section) {
    case 'plugins': {
      const rows = Array.isArray(record.rows) ? record.rows : []
      return toJson({
        id: record.id ?? null,
        name: record.name ?? null,
        displayName: record.displayName ?? null,
        version: record.version ?? null,
        origin: record.origin ?? 'unknown',
        source: record.source ?? null,
        installSpec: record.installSpec ?? null,
        installMethod: record.installMethod ?? null,
        enabled: record.enabled ?? true,
        builtIn: record.builtIn ?? false,
        syncable: record.syncable ?? true,
        restorable: record.restorable ?? true,
        rows: rows.map(row => {
          const item = row !== null && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, JsonValue>) : {}
          return { rowId: item.rowId ?? null, moduleName: item.moduleName ?? null, enabled: item.enabled ?? true }
        }),
      })
    }
    case 'providers':
      return toJson({ ...record, entryId: null })
    case 'plugin-configs':
      return toJson({ ...record, entryIds: null })
    case 'mcp':
      return toJson({ ...record, entryId: null })
    default:
      return value
  }
}

/** Build the local item set of one section from a snapshot. */
export function localItemsFor(snapshot: ProfileSnapshot, section: SectionId): Map<string, LocalItem> {
  const items = new Map<string, LocalItem>()
  const put = (id: string, name: string, value: JsonValue): void => {
    items.set(id, { id, name, value, hash: sha256Json(comparisonValue(section, value)) })
  }
  switch (section) {
    case 'dsh-config':
      for (const file of snapshot.dsh.files) {
        put(file.path, shortName(file.path), toJson(file))
      }
      return items
    case 'providers':
      for (const provider of snapshot.providers) {
        put(provider.id, provider.displayName ?? provider.id, toJson(provider))
      }
      return items
    case 'plugins':
      for (const plugin of snapshot.plugins) {
        // A plugin without a reproducible install source cannot travel: it would
        // only ever produce a diff the other device cannot act on.
        if (!plugin.syncable || !plugin.restorable) continue
        put(plugin.id, plugin.displayName ?? plugin.name, toJson(plugin))
      }
      return items
    case 'plugin-configs':
      for (const config of snapshot.pluginConfigs) {
        put(config.pluginId, config.moduleName, toJson(config))
      }
      return items
    case 'mcp':
      for (const server of snapshot.mcp) {
        put(server.id, server.serverName, toJson(server))
      }
      return items
    case 'secrets':
      // The secret slice is a single opaque item; the engine encrypts it before
      // it ever reaches this layer.
      return items
    default:
      return items
  }
}

/** Build the remote item set of one section. */
export function remoteItemsFor(
  document: AnyRemoteSection | undefined,
  section: SectionId,
): Map<string, RemoteItemView> {
  const out = new Map<string, RemoteItemView>()
  if (document === undefined) return out
  for (const [id, entry] of Object.entries(document.items)) {
    const item = entry as RemoteItem<JsonValue>
    out.set(id, {
      id,
      name: itemName(section, id, item.value),
      value: item.value,
      hash: sha256Json(comparisonValue(section, item.value)),
      deleted: item.deleted === true,
      updatedAt: item.updatedAt,
      updatedBy: item.updatedBy,
    })
  }
  return out
}

/** Build the baseline item set of one section. */
export function baselineItemsFor(
  baseline: Record<string, { hash: string; value: JsonValue }> | undefined,
): Map<string, BaselineItem> {
  const out = new Map<string, BaselineItem>()
  if (baseline === undefined) return out
  for (const [id, entry] of Object.entries(baseline)) {
    out.set(id, { hash: entry.hash, value: entry.value })
  }
  return out
}

/** A short display name for a dsh-config file id. */
function shortName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/** A display name for a remote value, tolerant of an unexpected shape. */
function itemName(section: SectionId, id: string, value: JsonValue): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return id
  const record = value as Record<string, JsonValue>
  const candidates = ['displayName', 'serverName', 'moduleName', 'name', 'path', 'pluginId']
  for (const key of candidates) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return id
}

/** The fields that differ between two JSON objects, dotted for readability. */
export function changedFields(left: JsonValue, right: JsonValue, prefix = '', depth = 0): string[] {
  if (depth > 6) return [prefix === '' ? '(value)' : prefix]
  if (stableStringify(left) === stableStringify(right)) return []
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    const out: string[] = []
    for (const key of [...keys].sort()) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      const leftValue = key in left ? (left[key] as JsonValue) : null
      const rightValue = key in right ? (right[key] as JsonValue) : null
      out.push(...changedFields(leftValue, rightValue, path, depth + 1))
    }
    return out.slice(0, 20)
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return prefix === '' ? ['(list)'] : [prefix]
  }
  return [prefix === '' ? '(value)' : prefix]
}

function isPlainObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Merge outcome for one item. */
export interface ItemMerge {
  /** Which side wins, or `none` when nothing may be written. */
  take: 'local' | 'remote' | 'none'
  /** Merged value when both sides changed different parts of one document. */
  merged?: JsonValue
  /** Set when the local side removed an item the baseline knew. */
  localDeleted?: boolean
  /** Set when the remote side recorded a tombstone for an item the baseline knew. */
  remoteDeleted?: boolean
  /** Set when the two sides cannot be reconciled automatically. */
  conflict: boolean
  /** Fields that differ, for the conflict UI. */
  fields: string[]
}

/**
 * Three-way merge for one item.
 *
 * The rule is the standard one, with two deliberate choices:
 *
 *  - a **missing baseline** makes two different values a conflict instead of a
 *    coin flip, because this plugin cannot know which device is newer;
 *  - a **deletion** is only attributed to a side when the baseline proves the
 *    item used to be there, so a value this device never had is adopted rather
 *    than deleted.
 */
export function mergeItem(
  section: SectionId,
  local: LocalItem | undefined,
  remote: RemoteItemView | undefined,
  base: BaselineItem | undefined,
): ItemMerge {
  const localPresent = local !== undefined
  const remotePresent = remote !== undefined && !remote.deleted
  const remoteKnown = remote !== undefined
  const basePresent = base !== undefined

  if (!localPresent && !remotePresent) return { take: 'none', conflict: false, fields: [] }

  if (localPresent && !remoteKnown) {
    // The store has never seen this item: a plain upload.
    return { take: 'local', conflict: false, fields: [] }
  }

  if (!localPresent && remotePresent) {
    // Either this device never had the value (adopt it) or it deleted a value
    // the baseline knew (the deletion has to travel as a tombstone).
    if (basePresent) return { take: 'local', localDeleted: true, conflict: false, fields: [] }
    return { take: 'remote', conflict: false, fields: [] }
  }

  if (localPresent && !remotePresent) {
    // A remote tombstone. With a baseline it is a deliberate removal; without
    // one it cannot be distinguished from an unreadable document, so it is
    // left alone instead of being acted on.
    if (basePresent) return { take: 'remote', remoteDeleted: true, conflict: false, fields: [] }
    return { take: 'none', conflict: false, fields: [] }
  }

  // Both sides have a value.
  const localItem = local as LocalItem
  const remoteItem = remote as RemoteItemView
  if (localItem.hash === remoteItem.hash) return { take: 'none', conflict: false, fields: [] }

  const fields = changedFields(comparisonValue(section, localItem.value), comparisonValue(section, remoteItem.value))
  if (!basePresent) {
    // First contact with two different values. A whole-value pick would be a
    // guess, but two documents that only add *different* entries can still be
    // merged safely — that is the common "new device adopts a shared config"
    // case, and refusing it would force a manual decision on every join.
    const merged = tryAutoMergeWithoutBase(section, localItem.value, remoteItem.value)
    if (merged !== null) return { take: 'local', merged, conflict: false, fields }
    return { take: 'none', conflict: true, fields }
  }
  const baseItem = base as BaselineItem
  const localChanged = localItem.hash !== baseItem.hash
  const remoteChanged = remoteItem.hash !== baseItem.hash
  if (!localChanged && remoteChanged) return { take: 'remote', conflict: false, fields }
  if (localChanged && !remoteChanged) return { take: 'local', conflict: false, fields }

  // Both changed: try a document-aware auto-merge before declaring a conflict.
  const merged = tryAutoMerge(section, localItem.value, remoteItem.value, baseItem.value)
  if (merged !== null) return { take: 'local', merged, conflict: false, fields }
  return { take: 'none', conflict: true, fields }
}

/**
 * Merge two changes that touched different parts of the same document.
 *
 * Configuration files are the case that matters: two devices editing different
 * Loader entries in one patch file must merge, not conflict. Entry ids make
 * that decidable, and the raw block text keeps `!!js` expressions intact.
 */
export function tryAutoMerge(
  section: SectionId,
  local: JsonValue,
  remote: JsonValue,
  base: JsonValue,
): JsonValue | null {
  if (section !== 'dsh-config') return null
  const localFile = asConfigFile(local)
  const remoteFile = asConfigFile(remote)
  const baseFile = asConfigFile(base)
  if (localFile === null || remoteFile === null || baseFile === null) return null
  if (localFile.kind !== remoteFile.kind) return null

  if (localFile.kind === 'profile-package') return mergePackageJson(localFile, remoteFile, baseFile)
  return mergePatchFile(localFile, remoteFile, baseFile)
}

/**
 * Merge two documents with no shared baseline.
 *
 * A missing baseline means every entry looks "new", so a merge is only safe
 * when the two sides do not disagree about the same thing. The synthetic base
 * is empty: two docs that both add the *same* entry id with different content
 * conflict, while disjoint additions merge. `package.json` gets an empty object
 * so dependency keys are compared individually.
 */
export function tryAutoMergeWithoutBase(
  section: SectionId,
  local: JsonValue,
  remote: JsonValue,
): JsonValue | null {
  if (section !== 'dsh-config') return null
  const localFile = asConfigFile(local)
  const remoteFile = asConfigFile(remote)
  if (localFile === null || remoteFile === null) return null
  if (localFile.kind !== remoteFile.kind || localFile.path !== remoteFile.path) return null
  const emptyBase: ConfigFileRecord = {
    ...localFile,
    content: localFile.kind === 'profile-package' ? '{}\n' : '',
    size: 0,
    sha256: sha256Text(''),
  }
  return tryAutoMerge(section, local, remote, toJson(emptyBase))
}

/** An entry id → verbatim block text map of a patch document. */
function patchEntryMap(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of splitPatch(text).blocks) {
    const ids = [block.id, ...block.insertIds].filter((id): id is string => id !== null && id !== '')
    for (const id of ids) map.set(id, block.text)
  }
  return map
}

/** Merge two patch documents when their changed entry ids are disjoint. */
function mergePatchFile(
  local: ConfigFileRecord,
  remote: ConfigFileRecord,
  base: ConfigFileRecord,
): JsonValue | null {
  const localMap = patchEntryMap(local.content)
  const remoteMap = patchEntryMap(remote.content)
  const baseMap = patchEntryMap(base.content)
  const ids = new Set([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()])

  const localChanged: string[] = []
  const remoteChanged: string[] = []
  for (const id of ids) {
    const baseText = baseMap.get(id)
    if (localMap.get(id) !== baseText) localChanged.push(id)
    if (remoteMap.get(id) !== baseText) remoteChanged.push(id)
  }
  // Agreement on an entry is not a conflict, even when neither side can prove
  // who changed it (a first contact has no baseline at all): only entries that
  // ended up with *different* text on the two sides need a user decision.
  const overlap = localChanged.filter(
    id => remoteChanged.includes(id) && (localMap.get(id) ?? null) !== (remoteMap.get(id) ?? null),
  )
  if (overlap.length > 0) return null

  const merged = mergePatch(local.content, remote.content, { takeIds: remoteChanged })
  if (merged.addedIds.length === 0 && merged.changedIds.length === 0) return toJson(local)
  const record: ConfigFileRecord = {
    ...local,
    content: merged.text,
    size: Buffer.byteLength(merged.text, 'utf8'),
    sha256: sha256Text(merged.text),
  }
  return toJson(record)
}

/**
 * Merge a profile `package.json` key by key.
 *
 * A version bump of one dependency on each device is a merge, not a conflict;
 * the same dependency changed to two different versions is a conflict. The
 * bundle list is treated as a set for the same reason.
 */
function mergePackageJson(
  local: ConfigFileRecord,
  remote: ConfigFileRecord,
  base: ConfigFileRecord,
): JsonValue | null {
  const localDoc = parseJsonObject(local.content)
  const remoteDoc = parseJsonObject(remote.content)
  const baseDoc = parseJsonObject(base.content)
  if (localDoc === null || remoteDoc === null || baseDoc === null) return null

  const merged: JsonObject = { ...localDoc }
  const keys = new Set([...Object.keys(localDoc), ...Object.keys(remoteDoc), ...Object.keys(baseDoc)])
  for (const key of keys) {
    if (key === 'dependencies' || key === 'dsh') continue
    const baseValue = baseDoc[key] ?? null
    const localValue = localDoc[key] ?? null
    const remoteValue = remoteDoc[key] ?? null
    const localChanged = stableStringify(localValue) !== stableStringify(baseValue)
    const remoteChanged = stableStringify(remoteValue) !== stableStringify(baseValue)
    if (localChanged && remoteChanged && stableStringify(localValue) !== stableStringify(remoteValue)) return null
    if (!remoteChanged) continue
    if (key in remoteDoc) merged[key] = remoteDoc[key] as JsonValue
    else delete merged[key]
  }

  const localDeps = objectOrEmpty(localDoc.dependencies)
  const remoteDeps = objectOrEmpty(remoteDoc.dependencies)
  const baseDeps = objectOrEmpty(baseDoc.dependencies)
  const dependencies: JsonObject = { ...localDeps }
  for (const name of new Set([...Object.keys(localDeps), ...Object.keys(remoteDeps), ...Object.keys(baseDeps)])) {
    const baseSpec = baseDeps[name]
    const localSpec = localDeps[name]
    const remoteSpec = remoteDeps[name]
    const localChanged = localSpec !== baseSpec
    const remoteChanged = remoteSpec !== baseSpec
    if (localChanged && remoteChanged && localSpec !== remoteSpec) return null
    if (!remoteChanged) continue
    if (remoteSpec === undefined) delete dependencies[name]
    else dependencies[name] = remoteSpec
  }
  merged.dependencies = dependencies

  const localBundles = readBundles(localDoc)
  const remoteBundles = readBundles(remoteDoc)
  const baseBundles = readBundles(baseDoc)
  const bundles = [...localBundles]
  for (const bundle of remoteBundles) {
    if (!bundles.includes(bundle)) bundles.push(bundle)
  }
  for (const bundle of baseBundles) {
    if (remoteBundles.includes(bundle)) continue
    // A bundle the remote dropped is only removed when this device did not
    // already keep it on purpose.
    if (localBundles.includes(bundle) && !baseBundles.includes(bundle)) continue
    const index = bundles.indexOf(bundle)
    if (index !== -1) bundles.splice(index, 1)
  }
  const dsh = objectOrEmpty(merged.dsh)
  const profile = objectOrEmpty(dsh.profile)
  merged.dsh = { ...dsh, profile: { ...profile, bundles: sanitizeJson(bundles) } }

  const content = `${JSON.stringify(merged, null, 2)}\n`
  return toJson({ ...local, content, size: Buffer.byteLength(content, 'utf8') })
}

/** Narrow a stored value to a configuration file record. */
export function asConfigFile(value: JsonValue): ConfigFileRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as unknown as ConfigFileRecord
  if (typeof record.path !== 'string' || typeof record.content !== 'string' || typeof record.kind !== 'string') {
    return null
  }
  return record
}

function objectOrEmpty(value: JsonValue | undefined): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonObject
}

/** Read `dsh.profile.bundles` as a string list, tolerating an unexpected shape. */
function readBundles(doc: JsonObject): string[] {
  const dsh = objectOrEmpty(doc.dsh as JsonValue | undefined)
  const profile = objectOrEmpty(dsh.profile as JsonValue | undefined)
  const bundles = profile.bundles
  return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : []
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as JsonObject
  } catch {
    return null
  }
}

/** Compute the current hash for an item value. */
export function hashOf(value: JsonValue): string {
  return sha256Json(value)
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

/** Inputs of {@link buildPlan}. */
export interface PlanInput {
  direction: 'push' | 'pull' | 'two-way'
  profile: string
  snapshot: ProfileSnapshot
  /** Remote sections of this profile, keyed by section. */
  remote: Map<SectionId, AnyRemoteSection>
  /** Baseline for this profile, keyed by section then item id. */
  baseline: Record<string, Record<string, BaselineItem>>
  /** Section switches from the configuration. */
  enabled: Record<SectionId, boolean>
  /** Item ids excluded per section. */
  excluded: Record<SectionId, string[]>
  /** A user's decisions about conflicts from a previous preview. */
  resolutions: ConflictResolution[]
  /** Secrets envelope to push, when the secrets scope may run. */
  secretsEnvelope?: SecretsEnvelope | null
  now?: () => Date
}

/** Build the plan: what a backup, restore or sync would do. */
export function buildPlan(input: PlanInput): SyncPlan {
  const now = input.now ?? (() => new Date())
  const resolutionMap = new Map<string, ConflictResolution>()
  for (const resolution of input.resolutions) resolutionMap.set(`${resolution.section}\u0000${resolution.id}`, resolution)

  const actions: PlanAction[] = []
  const conflicts: ConflictInfo[] = []
  const diffs: ItemDiff[] = []
  const warnings: string[] = []
  let localItemCount = 0
  let remoteItemCount = 0

  const direction = input.direction
  const canPush = direction === 'push' || direction === 'two-way'
  const canPull = direction === 'pull' || direction === 'two-way'

  for (const section of SECTION_IDS) {
    if (!input.enabled[section]) continue
    const excluded = new Set(input.excluded[section] ?? [])
    const localItems = section === 'secrets' ? secretLocalItems(input) : localItemsFor(input.snapshot, section)
    const remoteItems = remoteItemsFor(input.remote.get(section), section)
    const baseline = baselineItemsFor(input.baseline[section])
    localItemCount += localItems.size
    remoteItemCount += [...remoteItems.values()].filter(item => !item.deleted).length

    if (section === 'secrets' && input.enabled.secrets) {
      // A secret envelope is opaque, so it never three-way merges. The engine
      // decides whether this run may push one; otherwise the remote envelope is
      // pulled and the local payload is merged into the credential store by the
      // applier (which preserves local-only references).
      const localEnvelope = input.secretsEnvelope ?? null
      const remoteEntry = remoteItems.get('secrets')
      const remotePresent = remoteEntry !== undefined && remoteEntry.deleted !== true
      if (localEnvelope !== null && canPush) {
        const same = remoteEntry !== undefined && remoteEntry.hash === sha256Json(toJson(localEnvelope))
        if (!same) {
          actions.push({
            kind: 'push-secret',
            section,
            id: 'secrets',
            name: 'secrets',
            detail: '加密后的密钥包 / encrypted secret envelope',
            destructive: false,
            value: toJson(localEnvelope),
          })
        }
      }
      if (remotePresent && canPull && (localEnvelope === null || remoteEntry?.hash !== sha256Json(toJson(localEnvelope)))) {
        actions.push({
          kind: 'write-secret',
          section,
          id: 'secrets',
          name: 'secrets',
          detail: '从存储恢复加密密钥包 / restore the encrypted secret envelope',
          destructive: false,
          value: remoteEntry?.value ?? null,
        })
      }
      if (remotePresent && localEnvelope !== null && remoteEntry?.hash !== sha256Json(toJson(localEnvelope))) {
        warnings.push('密钥包两端不同，本次不做自动合并 / the two secret envelopes differ; not merged automatically')
      }
      continue
    }

    const ids = new Set<string>([...localItems.keys(), ...remoteItems.keys(), ...baseline.keys()])
    for (const id of [...ids].sort()) {
      if (excluded.has(id)) continue
      const local = localItems.get(id)
      const remote = remoteItems.get(id)
      const base = baseline.get(id)
      const merge = mergeItem(section, local, remote, base)
      const name = local?.name ?? remote?.name ?? id
      const key = `${section}\u0000${id}`
      const resolution = resolutionMap.get(key)

      if (merge.conflict) {
        const conflict: ConflictInfo = {
          section,
          id,
          name,
          reason:
            base === undefined
              ? '两端都有不同内容，且没有共同基线 / both sides differ and no shared baseline exists'
              : '两端都修改了该条目 / both sides changed this item',
          fields: merge.fields,
          local: local?.value ?? null,
          remote: remote?.value ?? null,
          base: base?.value ?? null,
          remoteDevice: remote?.updatedBy,
          remoteUpdatedAt: remote?.updatedAt,
        }
        diffs.push({ section, id, name, kind: 'changed', fields: merge.fields, destructive: false, conflict })
        if (resolution === undefined) {
          conflicts.push(conflict)
          continue
        }
        if (resolution.choice === 'skip') continue
        if (resolution.choice === 'local') {
          if (canPush && local !== undefined) {
            actions.push(pushAction(section, id, name, local.value, 'conflict resolved locally'))
          }
          continue
        }
        // The user chose the remote value.
        if (canPull) actions.push(...pullActions(section, id, name, remote?.value ?? null, 'conflict resolved remotely'))
        continue
      }

      const kind: ItemDiff['kind'] =
        merge.take === 'none'
          ? 'identical'
          : merge.localDeleted === true
            ? 'deleted-local'
            : merge.remoteDeleted === true
              ? 'deleted-remote'
              : merge.take === 'remote'
                ? local === undefined
                  ? 'remote-only'
                  : 'changed'
                : remote === undefined
                  ? 'local-only'
                  : 'changed'
      if (kind !== 'identical') {
        diffs.push({
          section,
          id,
          name,
          kind,
          fields: merge.fields,
          destructive: kind === 'deleted-remote' || kind === 'deleted-local',
        })
      }

      if (merge.take === 'local') {
        if (merge.merged !== undefined && section === 'dsh-config') {
          // Two documents that only added different entries were merged: the
          // merged document is the new local truth and also the value to push.
          if (canPull) {
            actions.push({
              kind: 'write-dsh-config',
              section,
              id,
              name,
              detail: '合并后的配置文件 / merged configuration file',
              destructive: false,
              value: merge.merged,
            })
          }
          if (canPush) actions.push(pushAction(section, id, name, merge.merged, 'merged document'))
          continue
        }
        if (merge.localDeleted === true) {
          // This device removed an item the store still has. The tombstone is a
          // destructive store change, so it stays visible until confirmed.
          if (canPush) {
            actions.push({
              kind: 'remove-remote-item',
              section,
              id,
              name,
              detail: '本地已删除，写入墓碑 / the item was removed locally; record a tombstone',
              destructive: true,
            })
          }
          continue
        }
        if (!canPush) {
          if (kind !== 'identical') warnings.push(`${name}: 仅本地修改，未推送 / local-only change, not pushed`)
          continue
        }
        const value = merge.merged ?? local?.value
        if (value === undefined) continue
        actions.push(pushAction(section, id, name, value, 'local change'))
        continue
      }

      if (merge.take === 'remote') {
        if (merge.remoteDeleted === true) {
          // The store removed it deliberately. Only a plugin can be removed
          // locally through a supported seam; anything else is reported and
          // left for the user rather than half-applied.
          if (canPull && section === 'plugins') {
            actions.push({
              kind: 'remove-plugin',
              section,
              id,
              name,
              detail: '远程已删除插件，将同时移除本地 / removed remotely; remove it locally too',
              destructive: true,
            })
          } else if (canPull) {
            warnings.push(`${name}: 远程已删除，本地不会自动删除 / removed remotely; not removed locally automatically`)
          }
          continue
        }
        if (!canPull) {
          if (kind !== 'identical') warnings.push(`${name}: 仅远端修改，未拉取 / remote-only change, not pulled`)
          continue
        }
        actions.push(...pullActions(section, id, name, remote?.value ?? null, 'remote change'))
        continue
      }
    }
  }

  const requiresConfirmation = actions.some(action => action.destructive) || conflicts.length > 0
  return {
    direction,
    profile: input.profile,
    generatedAt: now().toISOString(),
    actions,
    conflicts,
    diffs,
    requiresConfirmation,
    warnings,
    localItemCount,
    remoteItemCount,
  }
}

/** The local secrets item, when an envelope is available. */
function secretLocalItems(input: PlanInput): Map<string, LocalItem> {
  const items = new Map<string, LocalItem>()
  const envelope = input.secretsEnvelope ?? null
  if (envelope === null) return items
  const value = toJson(envelope)
  items.set('secrets', { id: 'secrets', name: 'secrets', value, hash: sha256Json(value) })
  return items
}

/** Build the push action for one section item. */
function pushAction(section: SectionId, id: string, name: string, value: JsonValue, detail: string): PlanAction {
  const base = { section, id, name, detail, destructive: false, value } as const
  switch (section) {
    case 'dsh-config':
      return { ...base, kind: 'push-dsh-config' }
    case 'providers':
      return { ...base, kind: 'push-provider' }
    case 'plugins': {
      const plugin = value as unknown as PluginRecord
      return {
        ...base,
        kind: 'push-plugin',
        installSpec: plugin.installSpec ?? undefined,
        version: plugin.version ?? undefined,
        enabled: plugin.enabled,
        detail: `${plugin.name}${plugin.version === null ? '' : `@${plugin.version}`}`,
      }
    }
    case 'plugin-configs':
      return { ...base, kind: 'push-plugin-config', values: asObject(value) }
    case 'mcp':
      return { ...base, kind: 'push-mcp' }
    case 'secrets':
      return { ...base, kind: 'push-secret' }
    default:
      return { ...base, kind: 'push-plugin' }
  }
}

/** Build the pull actions for one remote item. */
function pullActions(
  section: SectionId,
  id: string,
  name: string,
  value: JsonValue | null,
  detail: string,
): PlanAction[] {
  if (value === null) return []
  const base = { section, id, name, destructive: false, value } as const
  switch (section) {
    case 'dsh-config':
      return [{ ...base, kind: 'write-dsh-config', detail }]
    case 'providers':
      return [{ ...base, kind: 'write-provider', detail }]
    case 'plugins': {
      const plugin = value as unknown as PluginRecord
      const actions: PlanAction[] = [
        {
          ...base,
          kind: 'install-plugin',
          detail: `${plugin.name}${plugin.version === null ? '' : `@${plugin.version}`}`,
          installSpec: plugin.installSpec ?? undefined,
          version: plugin.version ?? undefined,
          enabled: plugin.enabled,
        },
      ]
      return actions
    }
    case 'plugin-configs':
      return [{ ...base, kind: 'write-plugin-config', detail, values: asObject(value) }]
    case 'mcp':
      return [{ ...base, kind: 'write-mcp', detail }]
    case 'secrets':
      return [{ ...base, kind: 'write-secret', detail }]
    default:
      return []
  }
}

function asObject(value: JsonValue): JsonObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonObject
}

/**
 * Detect a version change between two plugin records.
 * @returns `upgrade`, `downgrade`, or null when the versions are equal or unknown.
 */
export function versionDirection(
  remoteVersion: string | null,
  localVersion: string | null,
): 'upgrade' | 'downgrade' | null {
  if (remoteVersion === null || localVersion === null) return null
  const comparison = compareVersions(remoteVersion, localVersion)
  if (comparison === 0) return null
  return comparison > 0 ? 'upgrade' : 'downgrade'
}

/** Count actions that touch one section. */
export function countSectionActions(plan: SyncPlan, section: SectionId): number {
  return plan.actions.filter(action => action.section === section).length
}

/** Build the remote sections the engine must write, given a plan's push actions. */
export function sectionValuesFromSnapshot(
  snapshot: ProfileSnapshot,
  section: SectionId,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [id, item] of localItemsFor(snapshot, section)) out[id] = item.value
  return out
}

/** The dsh-config section value assembled from a snapshot. */
export function dshSectionValue(snapshot: ProfileSnapshot): DshSectionValue {
  return {
    files: snapshot.dsh.files,
    entries: snapshot.dsh.entries,
    bundles: snapshot.dsh.bundles,
    dependencies: snapshot.dsh.dependencies,
  }
}

/** Narrow a remote section item value to a plugin config record. */
export function asPluginConfigRecord(value: JsonValue): PluginConfigRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as unknown as PluginConfigRecord
  if (typeof record.pluginId !== 'string' || typeof record.moduleName !== 'string') return null
  return record
}

/** Narrow a remote section item value to a provider record. */
export function asProviderRecord(value: JsonValue): ProviderRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as unknown as ProviderRecord
  if (typeof record.id !== 'string') return null
  return record
}

/** Narrow a remote section item value to an MCP record. */
export function asMcpRecord(value: JsonValue): McpServerRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as unknown as McpServerRecord
  if (typeof record.id !== 'string' || typeof record.serverName !== 'string') return null
  return record
}

/** Narrow a remote section item value to a plugin record. */
export function asPluginRecord(value: JsonValue): PluginRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as unknown as PluginRecord
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return null
  return record
}
