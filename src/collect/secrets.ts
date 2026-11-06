/**
 * Credential-store collection and restore.
 *
 * DSH keeps its secrets in `$DSH_HOME/.credentials.yaml`: a versioned document
 * with a `refs` mapping (environment-variable name → value) and a `records`
 * mapping (credential key → tagged record). This module reads that document and
 * the Host credential seam into a {@link SecretsPayload}, which the engine
 * encrypts before it ever reaches a backend, and writes a payload back on
 * restore.
 *
 * Three rules shape the whole module:
 *
 *  1. **A value never escapes.** Returned records and warnings carry names and
 *     counts only; a value exists only inside `payload.values`/`payload.records`
 *     in memory, on its way into (or out of) the encrypted envelope.
 *  2. **Prefer the Host seam.** When `ctx.credentials` is mounted, references
 *     are resolved through it (its precedence rules are the running ones) and
 *     records are read/written through `modifyRecord`, the seam's only write
 *     path. The file is the fallback and the write target when no seam exists.
 *  3. **Never guess.** The YAML reader below understands the subset this
 *     document uses (block mappings, block sequences, scalars, quoted strings);
 *     anything else fails with a line number, never with the line's content.
 * @module collect/secrets
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CREDENTIALS_FILE } from '../constants.js'
import { SyncError } from '../core/errors.js'
import { readTextFile, writePrivateFile } from '../core/fs.js'
import { asJsonObject, sanitizeJson } from '../core/json.js'
import type { Emittable } from '../core/yaml.js'
import { emitYaml } from '../core/yaml.js'
import type {
  JsonObject,
  JsonValue,
  SecretRecordEntry,
  SecretRefRecord,
  SecretsPayload,
  SyncLogger,
} from '../types.js'

// ---------------------------------------------------------------------------
// Minimal YAML reader (credentials document only)
// ---------------------------------------------------------------------------

/** A YAML value the minimal reader produces. */
export type MinimalYamlValue =
  | string
  | number
  | boolean
  | null
  | MinimalYamlValue[]
  | { [key: string]: MinimalYamlValue }

/**
 * Failure of the minimal YAML reader.
 *
 * The message carries a line number only: the offending line holds a secret, so
 * quoting it (as a general-purpose YAML parser would) would put that secret in
 * a log or an HTTP error body.
 */
export class MinimalYamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MinimalYamlError'
  }
}

/** One significant source line. */
interface SourceLine {
  indent: number
  text: string
  number: number
}

/** Whether a line starts a block sequence item. */
function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ')
}

/**
 * Cut a trailing ` # comment` from a line, ignoring `#` inside quotes.
 */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (quote === null) {
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) return text.slice(0, index)
      continue
    }
    if (quote === '"' && character === '\\') {
      index += 1
      continue
    }
    if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 1
        continue
      }
      quote = null
    }
  }
  return text
}

/** Split significant lines out of a document, dropping comments and blanks. */
function prepareLines(text: string): SourceLine[] {
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const lines: SourceLine[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const original = rawLines[index] ?? ''
    if (/^\s*$/.test(original)) continue
    const leading = /^[ \t]*/.exec(original)?.[0] ?? ''
    if (leading.includes('\t') && /^[ \t]*\t/.test(original)) {
      throw new MinimalYamlError(`invalid indentation at line ${index + 1}`)
    }
    const withoutIndent = original.slice(leading.length)
    if (withoutIndent.startsWith('#')) continue
    if (withoutIndent.startsWith('%') || withoutIndent.startsWith('---')) continue
    if (withoutIndent.startsWith('...')) break
    const content = stripComment(withoutIndent).trimEnd()
    if (content.trim() === '') continue
    lines.push({ indent: leading.length, text: content, number: index + 1 })
  }
  return lines
}

/** Unquote a quoted scalar; returns null when it is not quoted. */
function unquoteScalar(text: string, lineNumber: number): string | null {
  const first = text[0]
  if (first === "'") {
    if (!text.endsWith("'") || text.length < 2) throw new MinimalYamlError(`unterminated string at line ${lineNumber}`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (first === '"') {
    if (!text.endsWith('"') || text.length < 2) throw new MinimalYamlError(`unterminated string at line ${lineNumber}`)
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'string' ? parsed : text.slice(1, -1)
    } catch {
      return text.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    }
  }
  return null
}

/** Parse one scalar token. */
function parseScalar(text: string, lineNumber: number): MinimalYamlValue {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const quoted = unquoteScalar(trimmed, lineNumber)
  if (quoted !== null) return quoted
  if (trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL' || trimmed === '~') return null
  if (/^(true|True|TRUE)$/.test(trimmed)) return true
  if (/^(false|False|FALSE)$/.test(trimmed)) return false
  if (/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as MinimalYamlValue
    } catch {
      throw new MinimalYamlError(`unsupported flow collection at line ${lineNumber}`)
    }
  }
  return trimmed
}

/** Split `key: value` at the first structural colon; null when there is none. */
function splitKeyValue(text: string): { key: string; value: string } | null {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (quote === null) {
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === ':') {
        const next = text[index + 1]
        if (next === undefined || next === ' ' || next === '\t') {
          const rawKey = text.slice(0, index).trim()
          if (rawKey === '') return null
          const key = unquoteScalar(rawKey, 0) ?? rawKey
          return { key, value: text.slice(index + 1).trim() }
        }
      }
      continue
    }
    if (quote === '"' && character === '\\') {
      index += 1
      continue
    }
    if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 1
        continue
      }
      quote = null
    }
  }
  return null
}

/** Indentation-aware parser for the credentials document subset. */
class MinimalYamlParser {
  private readonly lines: SourceLine[]
  private index = 0

  constructor(lines: SourceLine[]) {
    this.lines = lines
  }

  /** Parse the whole document. */
  parse(): MinimalYamlValue {
    if (this.lines.length === 0) return {}
    const first = this.lines[0] as SourceLine
    if (this.lines.length === 1 && (first.text.startsWith('{') || first.text.startsWith('['))) {
      return parseScalar(first.text, first.number)
    }
    const value = this.parseBlock(first.indent)
    const remaining = this.lines[this.index]
    if (remaining !== undefined) throw new MinimalYamlError(`unexpected content at line ${remaining.number}`)
    return value
  }

  /** Parse the block starting at the current line. */
  private parseBlock(indent: number): MinimalYamlValue {
    const line = this.lines[this.index]
    if (line === undefined) throw new MinimalYamlError('unexpected end of document')
    if (isSequenceItem(line.text)) return this.parseSequence(indent)
    return this.parseMapping(indent)
  }

  /** Read the value that follows a `key:` on the same line. */
  private readValueAfterKey(rest: string, lineNumber: number, keyIndent: number): MinimalYamlValue {
    if (rest !== '') return parseScalar(rest, lineNumber)
    const next = this.lines[this.index]
    if (next === undefined || next.indent <= keyIndent) return null
    return this.parseBlock(next.indent)
  }

  /** Parse consecutive mapping entries at one indentation level. */
  private parseMapping(indent: number): { [key: string]: MinimalYamlValue } {
    const map: { [key: string]: MinimalYamlValue } = {}
    for (;;) {
      const line = this.lines[this.index]
      if (line === undefined) break
      if (line.indent < indent) break
      if (line.indent > indent) throw new MinimalYamlError(`unexpected indentation at line ${line.number}`)
      if (isSequenceItem(line.text)) break
      const pair = splitKeyValue(line.text)
      if (pair === null) throw new MinimalYamlError(`expected "key:" at line ${line.number}`)
      if (Object.prototype.hasOwnProperty.call(map, pair.key)) {
        throw new MinimalYamlError(`duplicate key at line ${line.number}`)
      }
      this.index += 1
      map[pair.key] = this.readValueAfterKey(pair.value, line.number, indent)
    }
    return map
  }

  /** Parse consecutive block sequence items at one indentation level. */
  private parseSequence(indent: number): MinimalYamlValue[] {
    const items: MinimalYamlValue[] = []
    for (;;) {
      const line = this.lines[this.index]
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) throw new MinimalYamlError(`unexpected indentation at line ${line.number}`)
      if (!isSequenceItem(line.text)) break
      const content = line.text.slice(1).trim()
      this.index += 1
      if (content === '') {
        const next = this.lines[this.index]
        if (next === undefined || next.indent <= indent) {
          items.push(null)
          continue
        }
        items.push(this.parseBlock(next.indent))
        continue
      }
      const pair = splitKeyValue(content)
      if (pair === null) {
        items.push(parseScalar(content, line.number))
        continue
      }
      // An inline mapping item: its keys align two columns after the `-`.
      const itemIndent = indent + 2
      const item: { [key: string]: MinimalYamlValue } = {}
      item[pair.key] = this.readValueAfterKey(pair.value, line.number, itemIndent)
      const sibling = this.lines[this.index]
      if (sibling !== undefined && sibling.indent === itemIndent && !isSequenceItem(sibling.text)) {
        const rest = this.parseMapping(itemIndent)
        for (const [key, value] of Object.entries(rest)) item[key] = value
      }
      items.push(item)
    }
    return items
  }
}

/**
 * Parse the subset of YAML the credentials document uses.
 *
 * Supports block mappings and sequences, plain and quoted scalars, and JSON
 * flow collections. Throws {@link MinimalYamlError} (line number only) on
 * anything else, so a malformed secret document is never half-understood.
 */
export function parseMinimalYaml(text: string): MinimalYamlValue {
  return new MinimalYamlParser(prepareLines(text)).parse()
}

// ---------------------------------------------------------------------------
// Credentials document model
// ---------------------------------------------------------------------------

/** One stored record as the document (or the seam) holds it. */
export interface StoredCredentialRecord {
  key: string
  kind: 'api-key' | 'grant'
  /** For `grant`: the owner-defined payload. For `api-key`: `{ key?, env? }`. */
  payload: JsonValue
}

/** Parsed credentials document. */
export interface ParsedCredentialsDocument {
  version: number
  /** Reference name → value. Secret material; never log it. */
  refs: Map<string, string>
  records: Map<string, StoredCredentialRecord>
  /** Top-level keys this module does not manage, preserved on a rewrite. */
  extra: Map<string, MinimalYamlValue>
  /** Whether the pre-release flat layout (`NAME: value` at the root) was read. */
  legacyFlat: boolean
}

/** Reference names must be usable as environment-variable names. */
const REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Credential record keys are `<scope>/<id>`. */
const RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Whether a value is a plain (non-array, non-null) object. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a name can be a synchronized reference. */
export function isCredentialReference(name: string): boolean {
  return REFERENCE_NAME.test(name)
}

/** Whether a key can be a synchronized record. */
export function isCredentialRecordKey(key: string): boolean {
  return RECORD_KEY.test(key)
}

/** Project one api-key record's fields into the payload our type carries. */
function apiKeyPayload(fields: Record<string, unknown>): JsonValue {
  const out: JsonObject = {}
  const key = fields['key']
  if (typeof key === 'string' && key !== '') out['key'] = key
  const env = asJsonObject(fields['env'])
  if (env !== null) {
    const values: JsonObject = {}
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string' && value !== '') values[name] = value
    }
    if (Object.keys(values).length > 0) out['env'] = values
  }
  return Object.keys(out).length === 0 ? null : out
}

/**
 * Parse one credentials document.
 *
 * Rejects a document it cannot prove it understands with a line number (never
 * the line's content), so a restore never rewrites a file this module only
 * half-read.
 */
export function parseCredentialsDocument(text: string): ParsedCredentialsDocument {
  const root = parseMinimalYaml(text)
  const refs = new Map<string, string>()
  const records = new Map<string, StoredCredentialRecord>()
  const extra = new Map<string, MinimalYamlValue>()
  if (root === null) return { version: 1, refs, records, extra, legacyFlat: false }
  const document = asMinimalMap(root)
  if (document === null) throw new MinimalYamlError('the credentials document must be a mapping')

  const hasVersion = Object.prototype.hasOwnProperty.call(document, 'version')
  if (!hasVersion) {
    // Pre-release flat layout: every top-level key is a reference.
    if (Object.keys(document).length === 0) return { version: 1, refs, records, extra, legacyFlat: false }
    for (const [name, value] of Object.entries(document)) {
      if (typeof value !== 'string') {
        throw new MinimalYamlError('the legacy credentials document must map names to strings')
      }
      if (!isCredentialReference(name)) throw new MinimalYamlError('the legacy credentials document has an invalid name')
      refs.set(name, value)
    }
    return { version: 1, refs, records, extra, legacyFlat: true }
  }

  const version = typeof document['version'] === 'number' ? document['version'] : 1
  const rawRefs = asMinimalMap(document['refs'] ?? {})
  if (rawRefs !== null) {
    for (const [name, value] of Object.entries(rawRefs)) {
      if (!isCredentialReference(name)) throw new MinimalYamlError('the credentials document has an invalid reference name')
      if (typeof value !== 'string') throw new MinimalYamlError('a credentials reference must be a string')
      if (value === '') continue
      refs.set(name, value)
    }
  }
  const rawRecords = asMinimalMap(document['records'] ?? {})
  if (rawRecords !== null) {
    for (const [key, value] of Object.entries(rawRecords)) {
      if (!isCredentialRecordKey(key)) throw new MinimalYamlError('the credentials document has an invalid record key')
      const fields = asMinimalMap(value)
      if (fields === null) throw new MinimalYamlError('a credentials record must be a mapping')
      const kind = fields['kind']
      if (kind === 'grant') {
        records.set(key, { key, kind: 'grant', payload: sanitizeJson(fields['payload'] ?? null) })
        continue
      }
      if (kind === 'api-key') {
        records.set(key, { key, kind: 'api-key', payload: apiKeyPayload(fields) })
        continue
      }
      throw new MinimalYamlError('a credentials record has an unknown tag')
    }
  }
  for (const [key, value] of Object.entries(document)) {
    if (key === 'version' || key === 'refs' || key === 'records') continue
    extra.set(key, value)
  }
  return { version, refs, records, extra, legacyFlat: false }
}

/** Narrow a minimal YAML value to a map. */
function asMinimalMap(value: unknown): Record<string, MinimalYamlValue> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, MinimalYamlValue>
}

/** Convert a minimal YAML value into something the YAML emitter accepts. */
function toEmittable(value: MinimalYamlValue): Emittable {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(item => toEmittable(item))
  const out: { [key: string]: Emittable } = {}
  for (const [key, item] of Object.entries(value)) out[key] = toEmittable(item)
  return out
}

/** Serialize a credentials document in the version-1 layout. */
export function serializeCredentialsDocument(document: ParsedCredentialsDocument): string {
  const out: { [key: string]: Emittable } = { version: document.version === 0 ? 1 : document.version }
  const refs: { [key: string]: Emittable } = {}
  for (const name of [...document.refs.keys()].sort()) refs[name] = document.refs.get(name) ?? ''
  out['refs'] = refs
  const records: { [key: string]: Emittable } = {}
  for (const key of [...document.records.keys()].sort()) {
    const record = document.records.get(key)
    if (record === undefined) continue
    records[key] = recordToDocumentValue(record)
  }
  out['records'] = records
  for (const key of [...document.extra.keys()].sort()) {
    const value = document.extra.get(key)
    if (value === undefined) continue
    out[key] = toEmittable(value)
  }
  return `${emitYaml(out)}\n`
}

/** Render one stored record back into the document's field shape. */
function recordToDocumentValue(record: StoredCredentialRecord): Emittable {
  if (record.kind === 'grant') {
    return { kind: 'grant', payload: toEmittable(sanitizeJson(record.payload)) }
  }
  const fields: { [key: string]: Emittable } = { kind: 'api-key' }
  const payload = asJsonObject(record.payload)
  if (payload !== null) {
    const key = payload['key']
    if (typeof key === 'string' && key !== '') fields['key'] = key
    const env = asJsonObject(payload['env'])
    if (env !== null) {
      const values: { [key: string]: Emittable } = {}
      for (const [name, value] of Object.entries(env)) {
        if (typeof value === 'string' && value !== '') values[name] = value
      }
      if (Object.keys(values).length > 0) fields['env'] = values
    }
  }
  return fields
}

// ---------------------------------------------------------------------------
// Host credential seam (structural, feature-detected)
// ---------------------------------------------------------------------------

/** The subset of `ctx.credentials` this module touches, as it actually behaves. */
interface CredentialsLike {
  resolve?: (ref: string) => Promise<{ value?: unknown; source?: unknown } | undefined>
  describe?: (ref: string) => Promise<{ configured?: unknown; source?: unknown; writable?: unknown } | undefined>
  set?: (ref: string, value: string) => Promise<unknown>
  unset?: (ref: string) => Promise<unknown>
  listRecords?: () => Promise<readonly { key?: unknown; kind?: unknown }[] | undefined>
  readRecord?: (key: string) => Promise<unknown>
  modifyRecord?: (key: string, mutate: (current: unknown) => unknown) => Promise<unknown>
  deleteRecord?: (key: string) => Promise<unknown>
}

/** Feature-detect the credential seam. */
function credentialsLike(value: unknown): CredentialsLike | null {
  if (!isRecordObject(value)) return null
  return value as CredentialsLike
}

/** Map a seam source label onto the record's source enum. */
function sourceOf(raw: unknown): SecretRefRecord['source'] {
  const text = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (text === '') return 'unknown'
  if (text.includes('environment') || text.includes('env')) return 'environment'
  if (text.includes('store') || text.includes('file') || text.includes('provider')) return 'store'
  return 'unknown'
}

/** Read the source a record read produced, normalized to the seam's two kinds. */
function recordKindOf(raw: unknown): 'api-key' | 'grant' | null {
  if (!isRecordObject(raw)) return null
  const kind = raw['kind']
  if (kind === 'api-key' || kind === 'grant') return kind
  return null
}

/** Normalize one record read from the seam into our payload shape. */
function storedRecordFromSeam(key: string, raw: unknown, fallbackKind: 'api-key' | 'grant'): StoredCredentialRecord | null {
  if (!isRecordObject(raw)) return null
  const kind = recordKindOf(raw) ?? fallbackKind
  if (kind === 'grant') {
    return { key, kind: 'grant', payload: sanitizeJson(raw['payload'] ?? null) }
  }
  return { key, kind: 'api-key', payload: apiKeyPayload(raw) }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Options of {@link readSecrets}. */
export interface SecretsReadOptions {
  /** Absolute DSH home; used to locate the credentials document. */
  dshHome?: string
  /** Explicit credentials document path; overrides `dshHome`. */
  credentialsPath?: string
  /** `ctx.credentials`, feature-detected. */
  credentials?: unknown
  /**
   * Reference names the profile's configuration points at (provider
   * `apiKeyEnv` values, …). The seam has no reference enumeration, so this is
   * how an environment-only reference is discovered.
   */
  candidateRefs?: readonly string[]
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Logger; receives counts and names, never values. */
  logger?: SyncLogger
}

/** Result of reading the secret slice. */
export interface SecretsReadResult {
  payload: SecretsPayload
  warnings: string[]
}

/** Resolve the credentials document path. */
export function credentialsDocumentPath(options: { dshHome?: string; credentialsPath?: string } = {}): string {
  if (options.credentialsPath !== undefined && options.credentialsPath !== '') return resolve(options.credentialsPath)
  const home =
    options.dshHome !== undefined && options.dshHome !== ''
      ? resolve(options.dshHome)
      : (process.env['DSH_HOME'] ?? '').trim() !== ''
        ? resolve(process.env['DSH_HOME'] as string)
        : join(homedir(), '.dsh')
  return join(home, CREDENTIALS_FILE)
}

/** Read the credentials document from disk, or null when it does not exist. */
async function readDocumentFromDisk(path: string): Promise<ParsedCredentialsDocument | null> {
  const text = await readTextFile(path)
  if (text === null) return null
  return parseCredentialsDocument(text)
}

/** Describe one reference without reading its value. */
async function describeReference(
  credentials: CredentialsLike,
  ref: string,
): Promise<SecretRefRecord['source'] | null> {
  if (typeof credentials.describe !== 'function') return null
  try {
    const info = await credentials.describe(ref)
    if (!isRecordObject(info)) return null
    if (info['configured'] === false) return null
    return sourceOf(info['source'])
  } catch {
    return null
  }
}

/** Resolve one reference to a value through the seam, when it is store-backed. */
async function resolveReference(credentials: CredentialsLike, ref: string): Promise<{ value: string; source: SecretRefRecord['source'] } | null> {
  if (typeof credentials.resolve !== 'function') return null
  try {
    const resolved = await credentials.resolve(ref)
    if (!isRecordObject(resolved)) return null
    const value = resolved['value']
    if (typeof value !== 'string' || value === '') return null
    return { value, source: sourceOf(resolved['source']) }
  } catch {
    return null
  }
}

/**
 * Read the secret slice.
 *
 * The Host seam is consulted first for reference values; the document provides
 * the durable store values and the records. Only store-backed references carry
 * a value: an environment-only reference is recorded as such (so another device
 * knows the profile needs that variable) but its value never leaves this
 * process — it might be a CI secret that must not reach a shared store.
 *
 * @throws SyncError('invalid-config') when the document exists but cannot be
 * parsed; the error names a line, never the line's content.
 */
export async function readSecrets(options: SecretsReadOptions = {}): Promise<SecretsReadResult> {
  const warnings: string[] = []
  const credentials = credentialsLike(options.credentials)
  const env = options.env ?? process.env
  const path = credentialsDocumentPath(options)

  let document: ParsedCredentialsDocument | null = null
  try {
    document = await readDocumentFromDisk(path)
  } catch (error) {
    if (error instanceof MinimalYamlError) {
      throw new SyncError('invalid-config', `凭证文件无法解析 / the credentials document could not be parsed: ${error.message}`)
    }
    throw new SyncError('invalid-config', '凭证文件无法读取 / the credentials document could not be read')
  }

  if (document === null) {
    warnings.push(`凭证文件不存在 / no credentials document was found at ${CREDENTIALS_FILE}`)
  }

  // Reference discovery: every store reference, plus the names the profile's
  // configuration points at (the seam cannot enumerate references).
  const candidateRefs = new Set<string>()
  if (document !== null) for (const ref of document.refs.keys()) candidateRefs.add(ref)
  for (const ref of options.candidateRefs ?? []) {
    const trimmed = ref.trim()
    if (trimmed !== '' && isCredentialReference(trimmed)) candidateRefs.add(trimmed)
  }

  const refSources = new Map<string, SecretRefRecord['source']>()
  const values: Record<string, string> = {}

  for (const ref of candidateRefs) {
    const stored = document?.refs.get(ref)
    if (stored !== undefined && stored !== '') {
      values[ref] = stored
      refSources.set(ref, 'store')
      continue
    }
    if (credentials !== null) {
      const described = await describeReference(credentials, ref)
      if (described === 'environment') {
        refSources.set(ref, 'environment')
        continue
      }
      const resolved = await resolveReference(credentials, ref)
      if (resolved !== null && resolved.source !== 'environment') {
        values[ref] = resolved.value
        refSources.set(ref, resolved.source === 'unknown' ? 'store' : resolved.source)
        continue
      }
    }
    const fromEnv = (env[ref] ?? '') !== ''
    if (fromEnv) {
      // Presence only: the value stays in the environment layer.
      refSources.set(ref, 'environment')
      continue
    }
    // Unconfigured reference named by the config: keep it so another device
    // knows the profile expects it, but mark it unknown rather than inventing a
    // source.
    if (document?.refs.has(ref) !== true) refSources.set(ref, 'unknown')
  }

  const refs: SecretRefRecord[] = [...refSources.entries()]
    .map(([ref, source]) => ({ ref, source }))
    .sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))

  // Records: the seam is authoritative when it offers enumeration.
  const records = new Map<string, SecretRecordEntry>()
  if (document !== null) {
    for (const [key, record] of document.records) {
      records.set(key, { key, kind: record.kind, payload: record.payload })
    }
  }
  if (credentials !== null && typeof credentials.listRecords === 'function') {
    try {
      const listed = await credentials.listRecords()
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          if (!isRecordObject(entry)) continue
          const key = entry['key']
          const kind = entry['kind']
          if (typeof key !== 'string' || !isCredentialRecordKey(key)) continue
          if (kind !== 'api-key' && kind !== 'grant') continue
          if (typeof credentials.readRecord !== 'function') {
            records.set(key, { key, kind, payload: null })
            continue
          }
          try {
            const raw = await credentials.readRecord(key)
            const normalized = storedRecordFromSeam(key, raw, kind)
            records.set(key, normalized === null ? { key, kind, payload: null } : { key, kind: normalized.kind, payload: normalized.payload })
          } catch {
            warnings.push(`凭证记录无法读取 / could not read a credential record: ${key}`)
            records.set(key, { key, kind, payload: null })
          }
        }
      }
    } catch {
      warnings.push('凭证存储无法枚举记录 / the credential store could not list its records')
    }
  }

  const payload: SecretsPayload = {
    refs,
    values,
    records: [...records.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
  }

  try {
    options.logger?.debug('read the secret slice', {
      refs: payload.refs.length,
      values: Object.keys(payload.values).length,
      records: payload.records.length,
    })
  } catch {
    // Logging must never break collection.
  }

  return { payload, warnings }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Options of {@link writeSecrets}. */
export interface SecretsWriteOptions {
  /** `ctx.credentials`, feature-detected; preferred over the file. */
  credentials?: unknown
  /** Credentials document path, used when no seam is mounted. */
  credentialsPath: string
  /** Logger; receives counts and names, never values. */
  logger?: SyncLogger
}

/** Result of restoring the secret slice. */
export interface SecretsWriteResult {
  /** References written. */
  updatedRefs: string[]
  /** Credential records written. */
  updatedRecords: string[]
  /** Names skipped, with the reason category only. */
  skipped: string[]
  warnings: string[]
}

/** Normalize one payload record into the document's record model. */
function storedFromPayload(entry: SecretRecordEntry): StoredCredentialRecord | null {
  if (!isRecordObject(entry)) return null
  const key = typeof entry.key === 'string' ? entry.key : ''
  if (!isCredentialRecordKey(key)) return null
  if (entry.kind === 'grant') {
    return { key, kind: 'grant', payload: sanitizeJson(entry.payload ?? null) }
  }
  if (entry.kind === 'api-key') {
    const payload = entry.payload
    if (isRecordObject(payload)) {
      const out: JsonObject = {}
      if (typeof payload['key'] === 'string' && payload['key'] !== '') out['key'] = payload['key']
      const env = asJsonObject(payload['env'])
      if (env !== null) out['env'] = sanitizeJson(env)
      return { key, kind: 'api-key', payload: Object.keys(out).length === 0 ? null : out }
    }
    return { key, kind: 'api-key', payload: null }
  }
  return null
}

/** Convert a stored record back into the seam's record object. */
function seamRecordOf(record: StoredCredentialRecord): Record<string, unknown> {
  if (record.kind === 'grant') return { kind: 'grant', payload: record.payload }
  const fields: Record<string, unknown> = { kind: 'api-key' }
  const payload = asJsonObject(record.payload)
  if (payload !== null) {
    if (typeof payload['key'] === 'string' && payload['key'] !== '') fields['key'] = payload['key']
    const env = asJsonObject(payload['env'])
    if (env !== null) fields['env'] = env
  }
  return fields
}

/** Error text safe to log: never the underlying message of a credential write. */
function safeFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(code)) return code
    if (/^[A-Za-z0-9._ -]{1,80}$/.test(error.name)) return error.name
  }
  return 'write failed'
}

/**
 * Write the secret slice back onto this device.
 *
 * The Host seam is preferred when it is mounted: references go through
 * `set`, records through `modifyRecord` (its only write path). Without a seam
 * the credentials document is rewritten atomically at mode 0600, preserving
 * every reference, record and top-level key the payload does not mention.
 *
 * Values never appear in a warning: a failed write is reported by reference
 * name and a coarse reason only.
 */
export async function writeSecrets(
  payload: SecretsPayload,
  options: SecretsWriteOptions,
): Promise<SecretsWriteResult> {
  const warnings: string[] = []
  const updatedRefs: string[] = []
  const updatedRecords: string[] = []
  const skipped: string[] = []
  const path = credentialsDocumentPath({ credentialsPath: options.credentialsPath })

  const refValues: Record<string, string> = {}
  for (const ref of payload.refs ?? []) {
    if (!isRecordObject(ref)) continue
    const name = typeof ref.ref === 'string' ? ref.ref : ''
    if (!isCredentialReference(name)) {
      skipped.push(name === '' ? 'invalid-reference' : name)
      continue
    }
    if (ref.source === 'environment') {
      // An environment-only reference has no stored value to restore.
      if (typeof payload.values?.[name] !== 'string') {
        skipped.push(name)
        continue
      }
    }
    const value = payload.values?.[name]
    if (typeof value !== 'string' || value === '') {
      skipped.push(name)
      continue
    }
    refValues[name] = value
  }
  // Values the reference list did not name are still restorable; a payload from
  // an older version may only carry the mapping.
  for (const [name, value] of Object.entries(payload.values ?? {})) {
    if (typeof value !== 'string' || value === '') continue
    if (!isCredentialReference(name)) continue
    if (refValues[name] === undefined) refValues[name] = value
  }

  const records = new Map<string, StoredCredentialRecord>()
  for (const entry of payload.records ?? []) {
    const stored = storedFromPayload(entry)
    if (stored === null) {
      const key = isRecordObject(entry) && typeof entry.key === 'string' ? entry.key : ''
      if (key !== '') skipped.push(key)
      continue
    }
    records.set(stored.key, stored)
  }

  const credentials = credentialsLike(options.credentials)
  if (credentials !== null && typeof credentials.set === 'function') {
    for (const [name, value] of Object.entries(refValues)) {
      try {
        await credentials.set(name, value)
        updatedRefs.push(name)
      } catch (error) {
        warnings.push(`无法写入密钥引用 / could not store the reference ${name}: ${safeFailureDetail(error)}`)
        skipped.push(name)
      }
    }
    if (records.size > 0) {
      if (typeof credentials.modifyRecord === 'function') {
        for (const record of records.values()) {
          try {
            const replacement = seamRecordOf(record)
            await credentials.modifyRecord(record.key, () => replacement)
            updatedRecords.push(record.key)
          } catch (error) {
            warnings.push(`无法写入凭证记录 / could not store the credential record ${record.key}: ${safeFailureDetail(error)}`)
            skipped.push(record.key)
          }
        }
      } else {
        warnings.push('凭证服务不支持写入记录 / the credential service cannot write records')
        for (const key of records.keys()) skipped.push(key)
      }
    }
    try {
      options.logger?.info('restored the secret slice through the credential service', {
        refs: updatedRefs.length,
        records: updatedRecords.length,
        skipped: skipped.length,
      })
    } catch {
      // Logging must never break a restore.
    }
    return { updatedRefs, updatedRecords, skipped, warnings }
  }

  // Fallback: rewrite the document atomically.
  let existing: ParsedCredentialsDocument | null = null
  try {
    existing = await readDocumentFromDisk(path)
  } catch (error) {
    if (error instanceof MinimalYamlError) {
      throw new SyncError('invalid-config', `凭证文件无法解析 / the credentials document could not be parsed: ${error.message}`)
    }
    throw new SyncError('invalid-config', '凭证文件无法读取 / the credentials document could not be read')
  }

  const document: ParsedCredentialsDocument =
    existing ?? { version: 1, refs: new Map(), records: new Map(), extra: new Map(), legacyFlat: false }
  for (const [name, value] of Object.entries(refValues)) {
    document.refs.set(name, value)
    updatedRefs.push(name)
  }
  for (const record of records.values()) {
    document.records.set(record.key, record)
    updatedRecords.push(record.key)
  }
  document.version = 1

  const text = serializeCredentialsDocument(document)
  const current = await readTextFile(path)
  if (current !== text) {
    try {
      await writePrivateFile(path, text)
    } catch {
      throw new SyncError('internal', '无法写入凭证文件 / the credentials document could not be written')
    }
  }

  try {
    options.logger?.info('restored the secret slice into the credentials document', {
      refs: updatedRefs.length,
      records: updatedRecords.length,
      skipped: skipped.length,
    })
  } catch {
    // Logging must never break a restore.
  }

  if (existing?.legacyFlat === true) {
    warnings.push('凭证文件已从旧版平铺格式迁移 / the credentials document was migrated from the pre-release flat layout')
  }
  return { updatedRefs, updatedRecords, skipped, warnings }
}
