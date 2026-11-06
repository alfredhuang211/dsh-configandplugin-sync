/**
 * Lossless-JSON helpers.
 *
 * A synchronized document may only contain {@link JsonValue}: the tool registry
 * rejects anything else, `JSON.stringify` would silently drop `undefined`, and
 * the Web UI cannot render a non-JSON value. These helpers enforce that at the
 * boundary instead of discovering it later.
 * @module core/json
 */

import type { JsonObject, JsonValue } from '../types.js'

/** Whether a value is lossless JSON (no `undefined`, `Date`, `Map`, `NaN`, ...). */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value as number)
  if (type !== 'object') return false
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (!isJsonValue(item, depth + 1)) return false
  }
  return true
}

/** Copy a value through JSON so it is detached and lossless. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Drop every key whose value is not lossless JSON, recursively. */
export function sanitizeJson(value: unknown): JsonValue {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as JsonValue
  if (type === 'number') return Number.isFinite(value as number) ? (value as number) : null
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item))
  if (type !== 'object') return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const out: JsonObject = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue
    out[key] = sanitizeJson(item)
  }
  return out
}

/** Order object keys recursively so a digest does not depend on insertion order. */
export function stableJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(item => stableJson(item))
  if (value === null || typeof value !== 'object') return value
  const out: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = stableJson(value[key] as JsonValue)
  }
  return out
}

/** Compact stable serialization, used for digests and baseline fingerprints. */
export function stableStringify(value: JsonValue): string {
  return JSON.stringify(stableJson(value))
}

/** Deep structural equality over lossless JSON. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(sanitizeJson(left)) === stableStringify(sanitizeJson(right))
}

/** Parse a JSON document, returning null instead of throwing. */
export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Narrow an unknown to a JSON object. */
export function asJsonObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return sanitizeJson(value) as JsonObject
}

/** Read a string field from an unknown record. */
export function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw : undefined
}

/** Read a boolean field from an unknown record. */
export function booleanField(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'boolean' ? raw : undefined
}
