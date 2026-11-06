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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CREDENTIALS_FILE } from '../constants.js';
import { SyncError } from '../core/errors.js';
import { readTextFile, writePrivateFile } from '../core/fs.js';
import { asJsonObject, sanitizeJson } from '../core/json.js';
import { emitYaml } from '../core/yaml.js';
/**
 * Failure of the minimal YAML reader.
 *
 * The message carries a line number only: the offending line holds a secret, so
 * quoting it (as a general-purpose YAML parser would) would put that secret in
 * a log or an HTTP error body.
 */
export class MinimalYamlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MinimalYamlError';
    }
}
/** Whether a line starts a block sequence item. */
function isSequenceItem(text) {
    return text === '-' || text.startsWith('- ');
}
/**
 * Cut a trailing ` # comment` from a line, ignoring `#` inside quotes.
 */
function stripComment(text) {
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quote === null) {
            if (character === '"' || character === "'") {
                quote = character;
                continue;
            }
            if (character === '#' && (index === 0 || /\s/.test(text[index - 1] ?? '')))
                return text.slice(0, index);
            continue;
        }
        if (quote === '"' && character === '\\') {
            index += 1;
            continue;
        }
        if (character === quote) {
            if (quote === "'" && text[index + 1] === "'") {
                index += 1;
                continue;
            }
            quote = null;
        }
    }
    return text;
}
/** Split significant lines out of a document, dropping comments and blanks. */
function prepareLines(text) {
    const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const lines = [];
    for (let index = 0; index < rawLines.length; index += 1) {
        const original = rawLines[index] ?? '';
        if (/^\s*$/.test(original))
            continue;
        const leading = /^[ \t]*/.exec(original)?.[0] ?? '';
        if (leading.includes('\t') && /^[ \t]*\t/.test(original)) {
            throw new MinimalYamlError(`invalid indentation at line ${index + 1}`);
        }
        const withoutIndent = original.slice(leading.length);
        if (withoutIndent.startsWith('#'))
            continue;
        if (withoutIndent.startsWith('%') || withoutIndent.startsWith('---'))
            continue;
        if (withoutIndent.startsWith('...'))
            break;
        const content = stripComment(withoutIndent).trimEnd();
        if (content.trim() === '')
            continue;
        lines.push({ indent: leading.length, text: content, number: index + 1 });
    }
    return lines;
}
/** Unquote a quoted scalar; returns null when it is not quoted. */
function unquoteScalar(text, lineNumber) {
    const first = text[0];
    if (first === "'") {
        if (!text.endsWith("'") || text.length < 2)
            throw new MinimalYamlError(`unterminated string at line ${lineNumber}`);
        return text.slice(1, -1).replace(/''/g, "'");
    }
    if (first === '"') {
        if (!text.endsWith('"') || text.length < 2)
            throw new MinimalYamlError(`unterminated string at line ${lineNumber}`);
        try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'string' ? parsed : text.slice(1, -1);
        }
        catch {
            return text.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
    }
    return null;
}
/** Parse one scalar token. */
function parseScalar(text, lineNumber) {
    const trimmed = text.trim();
    if (trimmed === '')
        return null;
    const quoted = unquoteScalar(trimmed, lineNumber);
    if (quoted !== null)
        return quoted;
    if (trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL' || trimmed === '~')
        return null;
    if (/^(true|True|TRUE)$/.test(trimmed))
        return true;
    if (/^(false|False|FALSE)$/.test(trimmed))
        return false;
    if (/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed))
        return Number(trimmed);
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            throw new MinimalYamlError(`unsupported flow collection at line ${lineNumber}`);
        }
    }
    return trimmed;
}
/** Split `key: value` at the first structural colon; null when there is none. */
function splitKeyValue(text) {
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quote === null) {
            if (character === '"' || character === "'") {
                quote = character;
                continue;
            }
            if (character === ':') {
                const next = text[index + 1];
                if (next === undefined || next === ' ' || next === '\t') {
                    const rawKey = text.slice(0, index).trim();
                    if (rawKey === '')
                        return null;
                    const key = unquoteScalar(rawKey, 0) ?? rawKey;
                    return { key, value: text.slice(index + 1).trim() };
                }
            }
            continue;
        }
        if (quote === '"' && character === '\\') {
            index += 1;
            continue;
        }
        if (character === quote) {
            if (quote === "'" && text[index + 1] === "'") {
                index += 1;
                continue;
            }
            quote = null;
        }
    }
    return null;
}
/** Indentation-aware parser for the credentials document subset. */
class MinimalYamlParser {
    lines;
    index = 0;
    constructor(lines) {
        this.lines = lines;
    }
    /** Parse the whole document. */
    parse() {
        if (this.lines.length === 0)
            return {};
        const first = this.lines[0];
        if (this.lines.length === 1 && (first.text.startsWith('{') || first.text.startsWith('['))) {
            return parseScalar(first.text, first.number);
        }
        const value = this.parseBlock(first.indent);
        const remaining = this.lines[this.index];
        if (remaining !== undefined)
            throw new MinimalYamlError(`unexpected content at line ${remaining.number}`);
        return value;
    }
    /** Parse the block starting at the current line. */
    parseBlock(indent) {
        const line = this.lines[this.index];
        if (line === undefined)
            throw new MinimalYamlError('unexpected end of document');
        if (isSequenceItem(line.text))
            return this.parseSequence(indent);
        return this.parseMapping(indent);
    }
    /** Read the value that follows a `key:` on the same line. */
    readValueAfterKey(rest, lineNumber, keyIndent) {
        if (rest !== '')
            return parseScalar(rest, lineNumber);
        const next = this.lines[this.index];
        if (next === undefined || next.indent <= keyIndent)
            return null;
        return this.parseBlock(next.indent);
    }
    /** Parse consecutive mapping entries at one indentation level. */
    parseMapping(indent) {
        const map = {};
        for (;;) {
            const line = this.lines[this.index];
            if (line === undefined)
                break;
            if (line.indent < indent)
                break;
            if (line.indent > indent)
                throw new MinimalYamlError(`unexpected indentation at line ${line.number}`);
            if (isSequenceItem(line.text))
                break;
            const pair = splitKeyValue(line.text);
            if (pair === null)
                throw new MinimalYamlError(`expected "key:" at line ${line.number}`);
            if (Object.prototype.hasOwnProperty.call(map, pair.key)) {
                throw new MinimalYamlError(`duplicate key at line ${line.number}`);
            }
            this.index += 1;
            map[pair.key] = this.readValueAfterKey(pair.value, line.number, indent);
        }
        return map;
    }
    /** Parse consecutive block sequence items at one indentation level. */
    parseSequence(indent) {
        const items = [];
        for (;;) {
            const line = this.lines[this.index];
            if (line === undefined || line.indent < indent)
                break;
            if (line.indent > indent)
                throw new MinimalYamlError(`unexpected indentation at line ${line.number}`);
            if (!isSequenceItem(line.text))
                break;
            const content = line.text.slice(1).trim();
            this.index += 1;
            if (content === '') {
                const next = this.lines[this.index];
                if (next === undefined || next.indent <= indent) {
                    items.push(null);
                    continue;
                }
                items.push(this.parseBlock(next.indent));
                continue;
            }
            const pair = splitKeyValue(content);
            if (pair === null) {
                items.push(parseScalar(content, line.number));
                continue;
            }
            // An inline mapping item: its keys align two columns after the `-`.
            const itemIndent = indent + 2;
            const item = {};
            item[pair.key] = this.readValueAfterKey(pair.value, line.number, itemIndent);
            const sibling = this.lines[this.index];
            if (sibling !== undefined && sibling.indent === itemIndent && !isSequenceItem(sibling.text)) {
                const rest = this.parseMapping(itemIndent);
                for (const [key, value] of Object.entries(rest))
                    item[key] = value;
            }
            items.push(item);
        }
        return items;
    }
}
/**
 * Parse the subset of YAML the credentials document uses.
 *
 * Supports block mappings and sequences, plain and quoted scalars, and JSON
 * flow collections. Throws {@link MinimalYamlError} (line number only) on
 * anything else, so a malformed secret document is never half-understood.
 */
export function parseMinimalYaml(text) {
    return new MinimalYamlParser(prepareLines(text)).parse();
}
/** Reference names must be usable as environment-variable names. */
const REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Credential record keys are `<scope>/<id>`. */
const RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Whether a value is a plain (non-array, non-null) object. */
function isRecordObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Whether a name can be a synchronized reference. */
export function isCredentialReference(name) {
    return REFERENCE_NAME.test(name);
}
/** Whether a key can be a synchronized record. */
export function isCredentialRecordKey(key) {
    return RECORD_KEY.test(key);
}
/** Project one api-key record's fields into the payload our type carries. */
function apiKeyPayload(fields) {
    const out = {};
    const key = fields['key'];
    if (typeof key === 'string' && key !== '')
        out['key'] = key;
    const env = asJsonObject(fields['env']);
    if (env !== null) {
        const values = {};
        for (const [name, value] of Object.entries(env)) {
            if (typeof value === 'string' && value !== '')
                values[name] = value;
        }
        if (Object.keys(values).length > 0)
            out['env'] = values;
    }
    return Object.keys(out).length === 0 ? null : out;
}
/**
 * Parse one credentials document.
 *
 * Rejects a document it cannot prove it understands with a line number (never
 * the line's content), so a restore never rewrites a file this module only
 * half-read.
 */
export function parseCredentialsDocument(text) {
    const root = parseMinimalYaml(text);
    const refs = new Map();
    const records = new Map();
    const extra = new Map();
    if (root === null)
        return { version: 1, refs, records, extra, legacyFlat: false };
    const document = asMinimalMap(root);
    if (document === null)
        throw new MinimalYamlError('the credentials document must be a mapping');
    const hasVersion = Object.prototype.hasOwnProperty.call(document, 'version');
    if (!hasVersion) {
        // Pre-release flat layout: every top-level key is a reference.
        if (Object.keys(document).length === 0)
            return { version: 1, refs, records, extra, legacyFlat: false };
        for (const [name, value] of Object.entries(document)) {
            if (typeof value !== 'string') {
                throw new MinimalYamlError('the legacy credentials document must map names to strings');
            }
            if (!isCredentialReference(name))
                throw new MinimalYamlError('the legacy credentials document has an invalid name');
            refs.set(name, value);
        }
        return { version: 1, refs, records, extra, legacyFlat: true };
    }
    const version = typeof document['version'] === 'number' ? document['version'] : 1;
    const rawRefs = asMinimalMap(document['refs'] ?? {});
    if (rawRefs !== null) {
        for (const [name, value] of Object.entries(rawRefs)) {
            if (!isCredentialReference(name))
                throw new MinimalYamlError('the credentials document has an invalid reference name');
            if (typeof value !== 'string')
                throw new MinimalYamlError('a credentials reference must be a string');
            if (value === '')
                continue;
            refs.set(name, value);
        }
    }
    const rawRecords = asMinimalMap(document['records'] ?? {});
    if (rawRecords !== null) {
        for (const [key, value] of Object.entries(rawRecords)) {
            if (!isCredentialRecordKey(key))
                throw new MinimalYamlError('the credentials document has an invalid record key');
            const fields = asMinimalMap(value);
            if (fields === null)
                throw new MinimalYamlError('a credentials record must be a mapping');
            const kind = fields['kind'];
            if (kind === 'grant') {
                records.set(key, { key, kind: 'grant', payload: sanitizeJson(fields['payload'] ?? null) });
                continue;
            }
            if (kind === 'api-key') {
                records.set(key, { key, kind: 'api-key', payload: apiKeyPayload(fields) });
                continue;
            }
            throw new MinimalYamlError('a credentials record has an unknown tag');
        }
    }
    for (const [key, value] of Object.entries(document)) {
        if (key === 'version' || key === 'refs' || key === 'records')
            continue;
        extra.set(key, value);
    }
    return { version, refs, records, extra, legacyFlat: false };
}
/** Narrow a minimal YAML value to a map. */
function asMinimalMap(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return null;
    return value;
}
/** Convert a minimal YAML value into something the YAML emitter accepts. */
function toEmittable(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (Array.isArray(value))
        return value.map(item => toEmittable(item));
    const out = {};
    for (const [key, item] of Object.entries(value))
        out[key] = toEmittable(item);
    return out;
}
/** Serialize a credentials document in the version-1 layout. */
export function serializeCredentialsDocument(document) {
    const out = { version: document.version === 0 ? 1 : document.version };
    const refs = {};
    for (const name of [...document.refs.keys()].sort())
        refs[name] = document.refs.get(name) ?? '';
    out['refs'] = refs;
    const records = {};
    for (const key of [...document.records.keys()].sort()) {
        const record = document.records.get(key);
        if (record === undefined)
            continue;
        records[key] = recordToDocumentValue(record);
    }
    out['records'] = records;
    for (const key of [...document.extra.keys()].sort()) {
        const value = document.extra.get(key);
        if (value === undefined)
            continue;
        out[key] = toEmittable(value);
    }
    return `${emitYaml(out)}\n`;
}
/** Render one stored record back into the document's field shape. */
function recordToDocumentValue(record) {
    if (record.kind === 'grant') {
        return { kind: 'grant', payload: toEmittable(sanitizeJson(record.payload)) };
    }
    const fields = { kind: 'api-key' };
    const payload = asJsonObject(record.payload);
    if (payload !== null) {
        const key = payload['key'];
        if (typeof key === 'string' && key !== '')
            fields['key'] = key;
        const env = asJsonObject(payload['env']);
        if (env !== null) {
            const values = {};
            for (const [name, value] of Object.entries(env)) {
                if (typeof value === 'string' && value !== '')
                    values[name] = value;
            }
            if (Object.keys(values).length > 0)
                fields['env'] = values;
        }
    }
    return fields;
}
/** Feature-detect the credential seam. */
function credentialsLike(value) {
    if (!isRecordObject(value))
        return null;
    return value;
}
/** Map a seam source label onto the record's source enum. */
function sourceOf(raw) {
    const text = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (text === '')
        return 'unknown';
    if (text.includes('environment') || text.includes('env'))
        return 'environment';
    if (text.includes('store') || text.includes('file') || text.includes('provider'))
        return 'store';
    return 'unknown';
}
/** Read the source a record read produced, normalized to the seam's two kinds. */
function recordKindOf(raw) {
    if (!isRecordObject(raw))
        return null;
    const kind = raw['kind'];
    if (kind === 'api-key' || kind === 'grant')
        return kind;
    return null;
}
/** Normalize one record read from the seam into our payload shape. */
function storedRecordFromSeam(key, raw, fallbackKind) {
    if (!isRecordObject(raw))
        return null;
    const kind = recordKindOf(raw) ?? fallbackKind;
    if (kind === 'grant') {
        return { key, kind: 'grant', payload: sanitizeJson(raw['payload'] ?? null) };
    }
    return { key, kind: 'api-key', payload: apiKeyPayload(raw) };
}
/** Resolve the credentials document path. */
export function credentialsDocumentPath(options = {}) {
    if (options.credentialsPath !== undefined && options.credentialsPath !== '')
        return resolve(options.credentialsPath);
    const home = options.dshHome !== undefined && options.dshHome !== ''
        ? resolve(options.dshHome)
        : (process.env['DSH_HOME'] ?? '').trim() !== ''
            ? resolve(process.env['DSH_HOME'])
            : join(homedir(), '.dsh');
    return join(home, CREDENTIALS_FILE);
}
/** Read the credentials document from disk, or null when it does not exist. */
async function readDocumentFromDisk(path) {
    const text = await readTextFile(path);
    if (text === null)
        return null;
    return parseCredentialsDocument(text);
}
/** Describe one reference without reading its value. */
async function describeReference(credentials, ref) {
    if (typeof credentials.describe !== 'function')
        return null;
    try {
        const info = await credentials.describe(ref);
        if (!isRecordObject(info))
            return null;
        if (info['configured'] === false)
            return null;
        return sourceOf(info['source']);
    }
    catch {
        return null;
    }
}
/** Resolve one reference to a value through the seam, when it is store-backed. */
async function resolveReference(credentials, ref) {
    if (typeof credentials.resolve !== 'function')
        return null;
    try {
        const resolved = await credentials.resolve(ref);
        if (!isRecordObject(resolved))
            return null;
        const value = resolved['value'];
        if (typeof value !== 'string' || value === '')
            return null;
        return { value, source: sourceOf(resolved['source']) };
    }
    catch {
        return null;
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
export async function readSecrets(options = {}) {
    const warnings = [];
    const credentials = credentialsLike(options.credentials);
    const env = options.env ?? process.env;
    const path = credentialsDocumentPath(options);
    let document = null;
    try {
        document = await readDocumentFromDisk(path);
    }
    catch (error) {
        if (error instanceof MinimalYamlError) {
            throw new SyncError('invalid-config', `凭证文件无法解析 / the credentials document could not be parsed: ${error.message}`);
        }
        throw new SyncError('invalid-config', '凭证文件无法读取 / the credentials document could not be read');
    }
    if (document === null) {
        warnings.push(`凭证文件不存在 / no credentials document was found at ${CREDENTIALS_FILE}`);
    }
    // Reference discovery: every store reference, plus the names the profile's
    // configuration points at (the seam cannot enumerate references).
    const candidateRefs = new Set();
    if (document !== null)
        for (const ref of document.refs.keys())
            candidateRefs.add(ref);
    for (const ref of options.candidateRefs ?? []) {
        const trimmed = ref.trim();
        if (trimmed !== '' && isCredentialReference(trimmed))
            candidateRefs.add(trimmed);
    }
    const refSources = new Map();
    const values = {};
    for (const ref of candidateRefs) {
        const stored = document?.refs.get(ref);
        if (stored !== undefined && stored !== '') {
            values[ref] = stored;
            refSources.set(ref, 'store');
            continue;
        }
        if (credentials !== null) {
            const described = await describeReference(credentials, ref);
            if (described === 'environment') {
                refSources.set(ref, 'environment');
                continue;
            }
            const resolved = await resolveReference(credentials, ref);
            if (resolved !== null && resolved.source !== 'environment') {
                values[ref] = resolved.value;
                refSources.set(ref, resolved.source === 'unknown' ? 'store' : resolved.source);
                continue;
            }
        }
        const fromEnv = (env[ref] ?? '') !== '';
        if (fromEnv) {
            // Presence only: the value stays in the environment layer.
            refSources.set(ref, 'environment');
            continue;
        }
        // Unconfigured reference named by the config: keep it so another device
        // knows the profile expects it, but mark it unknown rather than inventing a
        // source.
        if (document?.refs.has(ref) !== true)
            refSources.set(ref, 'unknown');
    }
    const refs = [...refSources.entries()]
        .map(([ref, source]) => ({ ref, source }))
        .sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
    // Records: the seam is authoritative when it offers enumeration.
    const records = new Map();
    if (document !== null) {
        for (const [key, record] of document.records) {
            records.set(key, { key, kind: record.kind, payload: record.payload });
        }
    }
    if (credentials !== null && typeof credentials.listRecords === 'function') {
        try {
            const listed = await credentials.listRecords();
            if (Array.isArray(listed)) {
                for (const entry of listed) {
                    if (!isRecordObject(entry))
                        continue;
                    const key = entry['key'];
                    const kind = entry['kind'];
                    if (typeof key !== 'string' || !isCredentialRecordKey(key))
                        continue;
                    if (kind !== 'api-key' && kind !== 'grant')
                        continue;
                    if (typeof credentials.readRecord !== 'function') {
                        records.set(key, { key, kind, payload: null });
                        continue;
                    }
                    try {
                        const raw = await credentials.readRecord(key);
                        const normalized = storedRecordFromSeam(key, raw, kind);
                        records.set(key, normalized === null ? { key, kind, payload: null } : { key, kind: normalized.kind, payload: normalized.payload });
                    }
                    catch {
                        warnings.push(`凭证记录无法读取 / could not read a credential record: ${key}`);
                        records.set(key, { key, kind, payload: null });
                    }
                }
            }
        }
        catch {
            warnings.push('凭证存储无法枚举记录 / the credential store could not list its records');
        }
    }
    const payload = {
        refs,
        values,
        records: [...records.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    };
    try {
        options.logger?.debug('read the secret slice', {
            refs: payload.refs.length,
            values: Object.keys(payload.values).length,
            records: payload.records.length,
        });
    }
    catch {
        // Logging must never break collection.
    }
    return { payload, warnings };
}
/** Normalize one payload record into the document's record model. */
function storedFromPayload(entry) {
    if (!isRecordObject(entry))
        return null;
    const key = typeof entry.key === 'string' ? entry.key : '';
    if (!isCredentialRecordKey(key))
        return null;
    if (entry.kind === 'grant') {
        return { key, kind: 'grant', payload: sanitizeJson(entry.payload ?? null) };
    }
    if (entry.kind === 'api-key') {
        const payload = entry.payload;
        if (isRecordObject(payload)) {
            const out = {};
            if (typeof payload['key'] === 'string' && payload['key'] !== '')
                out['key'] = payload['key'];
            const env = asJsonObject(payload['env']);
            if (env !== null)
                out['env'] = sanitizeJson(env);
            return { key, kind: 'api-key', payload: Object.keys(out).length === 0 ? null : out };
        }
        return { key, kind: 'api-key', payload: null };
    }
    return null;
}
/** Convert a stored record back into the seam's record object. */
function seamRecordOf(record) {
    if (record.kind === 'grant')
        return { kind: 'grant', payload: record.payload };
    const fields = { kind: 'api-key' };
    const payload = asJsonObject(record.payload);
    if (payload !== null) {
        if (typeof payload['key'] === 'string' && payload['key'] !== '')
            fields['key'] = payload['key'];
        const env = asJsonObject(payload['env']);
        if (env !== null)
            fields['env'] = env;
    }
    return fields;
}
/** Error text safe to log: never the underlying message of a credential write. */
function safeFailureDetail(error) {
    if (error instanceof Error) {
        const code = error.code;
        if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(code))
            return code;
        if (/^[A-Za-z0-9._ -]{1,80}$/.test(error.name))
            return error.name;
    }
    return 'write failed';
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
export async function writeSecrets(payload, options) {
    const warnings = [];
    const updatedRefs = [];
    const updatedRecords = [];
    const skipped = [];
    const path = credentialsDocumentPath({ credentialsPath: options.credentialsPath });
    const refValues = {};
    for (const ref of payload.refs ?? []) {
        if (!isRecordObject(ref))
            continue;
        const name = typeof ref.ref === 'string' ? ref.ref : '';
        if (!isCredentialReference(name)) {
            skipped.push(name === '' ? 'invalid-reference' : name);
            continue;
        }
        if (ref.source === 'environment') {
            // An environment-only reference has no stored value to restore.
            if (typeof payload.values?.[name] !== 'string') {
                skipped.push(name);
                continue;
            }
        }
        const value = payload.values?.[name];
        if (typeof value !== 'string' || value === '') {
            skipped.push(name);
            continue;
        }
        refValues[name] = value;
    }
    // Values the reference list did not name are still restorable; a payload from
    // an older version may only carry the mapping.
    for (const [name, value] of Object.entries(payload.values ?? {})) {
        if (typeof value !== 'string' || value === '')
            continue;
        if (!isCredentialReference(name))
            continue;
        if (refValues[name] === undefined)
            refValues[name] = value;
    }
    const records = new Map();
    for (const entry of payload.records ?? []) {
        const stored = storedFromPayload(entry);
        if (stored === null) {
            const key = isRecordObject(entry) && typeof entry.key === 'string' ? entry.key : '';
            if (key !== '')
                skipped.push(key);
            continue;
        }
        records.set(stored.key, stored);
    }
    const credentials = credentialsLike(options.credentials);
    if (credentials !== null && typeof credentials.set === 'function') {
        for (const [name, value] of Object.entries(refValues)) {
            try {
                await credentials.set(name, value);
                updatedRefs.push(name);
            }
            catch (error) {
                warnings.push(`无法写入密钥引用 / could not store the reference ${name}: ${safeFailureDetail(error)}`);
                skipped.push(name);
            }
        }
        if (records.size > 0) {
            if (typeof credentials.modifyRecord === 'function') {
                for (const record of records.values()) {
                    try {
                        const replacement = seamRecordOf(record);
                        await credentials.modifyRecord(record.key, () => replacement);
                        updatedRecords.push(record.key);
                    }
                    catch (error) {
                        warnings.push(`无法写入凭证记录 / could not store the credential record ${record.key}: ${safeFailureDetail(error)}`);
                        skipped.push(record.key);
                    }
                }
            }
            else {
                warnings.push('凭证服务不支持写入记录 / the credential service cannot write records');
                for (const key of records.keys())
                    skipped.push(key);
            }
        }
        try {
            options.logger?.info('restored the secret slice through the credential service', {
                refs: updatedRefs.length,
                records: updatedRecords.length,
                skipped: skipped.length,
            });
        }
        catch {
            // Logging must never break a restore.
        }
        return { updatedRefs, updatedRecords, skipped, warnings };
    }
    // Fallback: rewrite the document atomically.
    let existing = null;
    try {
        existing = await readDocumentFromDisk(path);
    }
    catch (error) {
        if (error instanceof MinimalYamlError) {
            throw new SyncError('invalid-config', `凭证文件无法解析 / the credentials document could not be parsed: ${error.message}`);
        }
        throw new SyncError('invalid-config', '凭证文件无法读取 / the credentials document could not be read');
    }
    const document = existing ?? { version: 1, refs: new Map(), records: new Map(), extra: new Map(), legacyFlat: false };
    for (const [name, value] of Object.entries(refValues)) {
        document.refs.set(name, value);
        updatedRefs.push(name);
    }
    for (const record of records.values()) {
        document.records.set(record.key, record);
        updatedRecords.push(record.key);
    }
    document.version = 1;
    const text = serializeCredentialsDocument(document);
    const current = await readTextFile(path);
    if (current !== text) {
        try {
            await writePrivateFile(path, text);
        }
        catch {
            throw new SyncError('internal', '无法写入凭证文件 / the credentials document could not be written');
        }
    }
    try {
        options.logger?.info('restored the secret slice into the credentials document', {
            refs: updatedRefs.length,
            records: updatedRecords.length,
            skipped: skipped.length,
        });
    }
    catch {
        // Logging must never break a restore.
    }
    if (existing?.legacyFlat === true) {
        warnings.push('凭证文件已从旧版平铺格式迁移 / the credentials document was migrated from the pre-release flat layout');
    }
    return { updatedRefs, updatedRecords, skipped, warnings };
}
