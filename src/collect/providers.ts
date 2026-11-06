/**
 * Model-provider normalization.
 *
 * Providers live inside the Loader entries of whichever LLM adapter declares
 * them, and different adapters spell the same idea differently: `pi-ai` keeps a
 * `providers` dict keyed by route, the DeepSeek adapter keeps one provider's
 * fields flat on the entry. This module reduces both to one
 * {@link ProviderRecord} the engine can compare and write back, plus the
 * profile's default model selection.
 *
 * A provider record never carries a credential: the entry config has already
 * been projected through `splitSecrets`, and this module applies the same rule
 * again as defence in depth, so a key configured directly (`apiKey` instead of
 * `apiKeyEnv`) is dropped rather than synchronized.
 * @module collect/providers
 */

import type {
  ConfigEntryRecord,
  JsonObject,
  ModelSelectionRecord,
  ProviderRecord,
} from '../types.js'
import { asJsonObject, sanitizeJson, stringField } from '../core/json.js'
import { isSecretKey, redactText, sanitizeUrl, splitSecrets } from '../core/redact.js'

/** Result of normalizing the provider declarations of one profile. */
export interface ProvidersResult {
  /** One record per provider route, deduped by id (the last declaration wins). */
  providers: ProviderRecord[]
  /** The profile's default model selection, when one is declared. */
  defaultModel: ModelSelectionRecord | null
  /** Non-fatal findings; never contains a configuration value. */
  warnings: string[]
}

/** Fields a provider record lifts out of the raw profile. */
const PROVIDER_KNOWN_FIELDS = new Set([
  'displayName',
  'name',
  'api',
  'baseURL',
  'baseUrl',
  'apiKeyEnv',
  'apiKeyRef',
  'models',
  'headers',
  'id',
  'provider',
  'route',
])

/** Whether an entry looks like it belongs to an LLM adapter. */
function looksLikeLlmEntry(entry: ConfigEntryRecord): boolean {
  const haystack = `${entry.id} ${entry.name ?? ''}`.toLowerCase()
  return (
    haystack.includes('llm') ||
    haystack.includes('provider') ||
    haystack.includes('model-adapter') ||
    haystack.includes('pi-ai') ||
    haystack.includes('openai') ||
    haystack.includes('anthropic')
  )
}

/** Extract model ids from the several shapes an adapter may use. */
export function modelIds(value: unknown): string[] {
  const out: string[] = []
  const push = (item: unknown): void => {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
      return
    }
    const record = asJsonObject(item)
    if (record === null) return
    const id = stringField(record, 'id') ?? stringField(record, 'model') ?? stringField(record, 'name')
    if (id !== undefined && id !== '' && !out.includes(id)) out.push(id)
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item)
    return out
  }
  const record = asJsonObject(value)
  if (record !== null) {
    // A dict keyed by model id: the key is the model identity.
    for (const [id, item] of Object.entries(record)) {
      if (item === null || item === undefined) continue
      push(id)
    }
  }
  return out
}

/** Remove a credential from a base URL without dropping the rest of it. */
function cleanBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '***') return undefined
  const hasUserInfo = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i.test(trimmed)
  if (!hasUserInfo) {
    // Nothing to remove: keep the user's spelling rather than a normalized URL.
    return redactText(trimmed) === trimmed ? trimmed : undefined
  }
  const sanitized = sanitizeUrl(trimmed)
  if (!sanitized.includes('***')) return sanitized
  // A credential in the userinfo can be removed while the endpoint stays
  // usable: it is not part of the address.
  try {
    const url = new URL(trimmed)
    url.username = ''
    url.password = ''
    const stripped = url.toString()
    return stripped.includes('***') ? undefined : stripped
  } catch {
    return undefined
  }
}

/**
 * Normalize one provider profile.
 *
 * @returns the record, plus the config paths dropped by the secret rules.
 */
function normalizeProviderProfile(
  id: string,
  entryId: string,
  raw: unknown,
  warnings: string[],
): { record: ProviderRecord; redacted: string[] } | null {
  const rawObject = asJsonObject(raw)
  if (rawObject === null) {
    warnings.push(`provider “${id}” 的定义不是对象 / provider “${id}” is not an object`)
    return null
  }
  // Defence in depth: the entry config was already filtered, but a provider
  // dict can be nested under a key the first pass did not treat as secret.
  const { clean, redacted } = splitSecrets(rawObject)
  const profile = asJsonObject(sanitizeJson(clean)) ?? {}
  const displayName = stringField(profile, 'displayName') ?? stringField(profile, 'name')
  const api = stringField(profile, 'api')
  const baseURL = cleanBaseUrl(stringField(profile, 'baseURL') ?? stringField(profile, 'baseUrl'))
  const apiKeyEnv = stringField(profile, 'apiKeyEnv') ?? stringField(profile, 'apiKeyRef')
  const models = modelIds(profile['models'])
  const extra: JsonObject = {}
  for (const [key, value] of Object.entries(profile)) {
    if (PROVIDER_KNOWN_FIELDS.has(key)) continue
    if (isSecretKey(key)) continue
    extra[key] = value
  }
  if (redacted.length > 0) {
    warnings.push(`provider “${id}” 的敏感字段未同步 / secret-looking fields were not synchronized: ${redacted.join(', ')}`)
  }
  const record: ProviderRecord = { id, entryId, models, extra }
  if (displayName !== undefined) record.displayName = displayName
  if (api !== undefined) record.api = api
  if (baseURL !== undefined) record.baseURL = baseURL
  if (apiKeyEnv !== undefined) record.apiKeyEnv = apiKeyEnv
  return { record, redacted }
}

/** Whether a config object carries a single provider's flat fields. */
function isFlatProviderConfig(config: JsonObject): boolean {
  return (
    config['apiKeyEnv'] !== undefined ||
    config['apiKeyRef'] !== undefined ||
    config['api'] !== undefined ||
    config['baseURL'] !== undefined ||
    config['baseUrl'] !== undefined ||
    (Array.isArray(config['models']) && config['models'].length > 0)
  )
}

/** Candidate provider id for a flat provider entry. */
function flatProviderId(entry: ConfigEntryRecord, config: JsonObject): string {
  for (const key of ['id', 'provider', 'route'] as const) {
    const candidate = stringField(config, key)
    if (candidate !== undefined) return candidate
  }
  return entry.id
}

/** Read providers out of one entry; appends to `byId`. */
function readEntryProviders(
  entry: ConfigEntryRecord,
  byId: Map<string, ProviderRecord>,
  warnings: string[],
): void {
  const providers = configObjectOf(entry.config, 'providers')
  if (providers !== null) {
    for (const [id, raw] of Object.entries(providers)) {
      const normalized = normalizeProviderProfile(id, entry.id, raw, warnings)
      if (normalized === null) continue
      // Last declaration wins: a later patch layer overrides an earlier bundle.
      byId.set(id, normalized.record)
    }
    return
  }
  if (!looksLikeLlmEntry(entry) || !isFlatProviderConfig(entry.config)) return
  const id = flatProviderId(entry, entry.config)
  const normalized = normalizeProviderProfile(id, entry.id, entry.config, warnings)
  if (normalized === null) return
  byId.set(id, normalized.record)
}

/** Read a nested object out of a config, returning null unless it is a map. */
function configObjectOf(config: JsonObject, key: string): JsonObject | null {
  return asJsonObject(config[key])
}

/** Whether an entry declares the default model selection. */
function isDefaultModelEntry(entry: ConfigEntryRecord): boolean {
  const haystack = `${entry.id} ${entry.name ?? ''}`.toLowerCase()
  return haystack.includes('default-model') || haystack.includes('defaultmodel') || haystack.includes('agent-default')
}

/** Read the default model selection from one entry, when it declares one. */
function readDefaultModel(entry: ConfigEntryRecord): ModelSelectionRecord | null {
  const config = entry.config
  const nested = configObjectOf(config, 'defaultModel') ?? configObjectOf(config, 'modelSelection')
  const source = nested ?? config
  const provider = stringField(source, 'provider')
  const model = stringField(source, 'model')
  if (provider === undefined && model === undefined) return null
  const record: ModelSelectionRecord = { entryId: entry.id }
  if (provider !== undefined) record.provider = provider
  if (model !== undefined) record.model = model
  return record
}

/**
 * Normalize every provider declaration in the profile.
 *
 * Providers are deduped by id across entries (the later entry wins, which
 * matches how Loader layers override each other); the record therefore always
 * names the entry a write-back should target.
 */
export function collectProviders(
  entries: readonly ConfigEntryRecord[],
  warnings: string[] = [],
): ProvidersResult {
  const byId = new Map<string, ProviderRecord>()
  let defaultModel: ModelSelectionRecord | null = null

  for (const entry of entries) {
    readEntryProviders(entry, byId, warnings)
    if (isDefaultModelEntry(entry)) {
      const selection = readDefaultModel(entry)
      if (selection !== null) defaultModel = selection
    }
  }

  if (defaultModel !== null && defaultModel.provider !== undefined && !byId.has(defaultModel.provider)) {
    warnings.push(
      `默认模型指向未声明的 provider / the default model names an undeclared provider: ${defaultModel.provider}`,
    )
  }

  const providers = [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { providers, defaultModel, warnings }
}
