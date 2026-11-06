/**
 * Loader-entry reading and secret-safe projection.
 *
 * Two sources exist for the same information and this module treats them as
 * interchangeable:
 *
 *  1. `ctx.configEditor.entries()` — the Host's parsed view, which is the only
 *     source that carries an entry's *config*;
 *  2. the literal patch files, split with {@link splitPatch} — a fallback that
 *     recovers identity (`id`, `name`, `disabled`) when no Host service is
 *     mounted, but not config values, because this plugin never re-parses YAML.
 *
 * Everything returned from here has passed {@link splitSecrets}, so a secret
 * value can never reach a synchronized record: the collector's records are
 * built on top of these functions only.
 *
 * Raw `!!js` expressions are represented by the Loader as an object carrying a
 * `__jsExpr` property. The record shape is lossless JSON, so they are projected
 * into the string `!!js <expression>` on read and converted back into a
 * {@link RawExpression} by {@link entryConfigToYamlValue} on write.
 * @module collect/entries
 */
import { splitPatch } from '../core/patch.js';
import { sanitizeJson, asJsonObject, isJsonValue } from '../core/json.js';
import { redactText, splitSecrets } from '../core/redact.js';
import { RawExpression } from '../core/yaml.js';
/** Prefix marking a serialized `!!js` expression inside a record. */
export const JS_EXPRESSION_PREFIX = '!!js ';
/** Whether a value is a non-array object (class instances included). */
function isRecordObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Read a trimmed non-empty string, or undefined. */
function safeText(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/** Whether a raw value is the Loader's `!!js` expression node. */
function isJsExpressionNode(value) {
    if (!isRecordObject(value))
        return false;
    const expression = value['__jsExpr'];
    return typeof expression === 'string';
}
/**
 * Project Loader `!!js` nodes into `!!js <expression>` strings.
 *
 * The result stays lossless JSON (which a record must be) and is converted
 * back into a {@link RawExpression} by {@link entryConfigToYamlValue}, so a
 * value that was an expression stays an expression through a restore.
 */
export function encodeJsExpressions(value) {
    if (isJsExpressionNode(value))
        return `${JS_EXPRESSION_PREFIX}${value.__jsExpr}`;
    if (Array.isArray(value))
        return value.map(item => encodeJsExpressions(item));
    if (!isRecordObject(value))
        return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return value;
    const out = {};
    for (const [key, item] of Object.entries(value))
        out[key] = encodeJsExpressions(item);
    return out;
}
/** Whether a string is a serialized `!!js` expression. */
export function isJsExpressionString(value) {
    return typeof value === 'string' && value.startsWith(JS_EXPRESSION_PREFIX);
}
/**
 * Convert a record's JSON config into a value the YAML emitter accepts.
 *
 * `!!js <expression>` strings become {@link RawExpression} (emitted verbatim) so
 * a restore writes the expression back instead of quoting it as a literal
 * string. Everything else must already be lossless JSON; non-JSON values are
 * dropped rather than guessed at.
 */
export function entryConfigToYamlValue(config) {
    const out = {};
    if (config === null || config === undefined)
        return out;
    for (const [key, value] of Object.entries(config)) {
        const converted = jsonToEmittable(value);
        if (converted !== undefined)
            out[key] = converted;
    }
    return out;
}
/** Convert one lossless JSON value into an emittable value, or undefined to drop it. */
export function jsonToEmittable(value, depth = 0) {
    if (depth > 64)
        return undefined;
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        return isJsExpressionString(value) ? new RawExpression(value.slice(JS_EXPRESSION_PREFIX.length)) : value;
    }
    if (Array.isArray(value)) {
        const items = [];
        for (const item of value) {
            const converted = jsonToEmittable(item, depth + 1);
            if (converted !== undefined)
                items.push(converted);
        }
        return items;
    }
    if (isRecordObject(value)) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return undefined;
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            const converted = jsonToEmittable(item, depth + 1);
            if (converted !== undefined)
                out[key] = converted;
        }
        return out;
    }
    return undefined;
}
/** Read entries from the Host config editor, defensively. */
function entriesFromEditor(editor, warnings) {
    if (!isRecordObject(editor))
        return null;
    // `configuration()` is the authoritative view: it carries the effective
    // config composed from the inherited layer and the profile override. The
    // Loader entry objects returned by `entries()` expose their config through
    // `options`, which is easy to miss and is handled below as a fallback.
    const composed = configurationEntries(editor, warnings);
    if (composed !== null)
        return composed;
    const read = editor.entries;
    if (typeof read !== 'function')
        return null;
    let raw;
    try {
        raw = read.call(editor);
    }
    catch {
        warnings.push('配置编辑服务读取失败 / the config editor could not list the Loader entries');
        return null;
    }
    if (!Array.isArray(raw)) {
        warnings.push('配置编辑服务返回了无效条目 / the config editor returned no entry list');
        return null;
    }
    const entries = [];
    for (const item of raw) {
        const identity = entryIdentity(item);
        if (identity === null)
            continue;
        entries.push({ ...identity, config: entryConfigValue(item), source: 'config-editor' });
    }
    return entries;
}
/** Read the raw config of a plain Loader entry or its `options`. */
function entryConfigValue(value) {
    if (!isRecordObject(value))
        return {};
    const record = value;
    if (isRecordObject(record.config))
        return { ...record.config };
    const options = isRecordObject(record.options) ? record.options : {};
    return isRecordObject(options.config) ? { ...options.config } : {};
}
/** Read `configEditor.configuration()`, or null when the service lacks it. */
function configurationEntries(editor, warnings) {
    const read = editor.configuration;
    if (typeof read !== 'function')
        return null;
    let raw;
    try {
        raw = read.call(editor);
    }
    catch {
        warnings.push('配置编辑服务无法读取有效配置 / the config editor could not read effective configuration');
        return null;
    }
    if (!Array.isArray(raw))
        return null;
    const entries = [];
    for (const item of raw) {
        if (!isRecordObject(item))
            continue;
        const identity = entryIdentity(item.entry);
        if (identity === null)
            continue;
        const inherited = isRecordObject(item.inherited) ? item.inherited : {};
        const override = isRecordObject(item.override) ? item.override : {};
        entries.push({ ...identity, config: deepMergeConfig(inherited, override), source: 'config-editor' });
    }
    return entries.length > 0 ? entries : null;
}
/** Read id/name/patchId/disabled from a Loader entry or its `options`. */
function entryIdentity(value) {
    if (!isRecordObject(value))
        return null;
    const record = value;
    const options = isRecordObject(record.options) ? record.options : {};
    const id = safeText(record.id) ?? safeText(options.id);
    if (id === undefined)
        return null;
    const name = safeText(record.name) ?? safeText(options.name);
    const patchId = safeText(record.patchId) ?? safeText(options.patchId);
    const disabled = typeof record.disabled === 'boolean' ? record.disabled : options.disabled;
    const identity = { id };
    if (name !== undefined)
        identity.name = name;
    if (patchId !== undefined)
        identity.patchId = patchId;
    if (typeof disabled === 'boolean')
        identity.disabled = disabled;
    return identity;
}
/**
 * Merge the inherited layer with the profile override.
 *
 * Nested maps merge recursively because that is how a provider dictionary is
 * overridden: a profile that adds one provider must not erase the others
 * inherited from the bundle layer. Arrays and scalars replace, matching the
 * Loader's own composition.
 */
function deepMergeConfig(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const existing = base[key];
        out[key] = isRecordObject(value) && isRecordObject(existing) ? deepMergeConfig(existing, value) : value;
    }
    return out;
}
/**
 * Read entry identity from the literal patch files.
 *
 * This is the degraded path used when no `configEditor` is mounted: a patch
 * block's `id`, `name` and `disabled` are recoverable without re-parsing YAML,
 * but its configuration is not — that needs the Host's parsed view.
 */
function entriesFromPatches(patchTexts, warnings) {
    const entries = [];
    for (const text of patchTexts) {
        if (typeof text !== 'string' || text.trim() === '')
            continue;
        let split;
        try {
            split = splitPatch(text);
        }
        catch {
            warnings.push('补丁文件无法解析 / a patch file could not be split into entries');
            continue;
        }
        for (const block of split.blocks) {
            if (block.kind === 'insert') {
                for (const row of insertRows(block.text)) {
                    entries.push({ ...row, config: {}, source: 'patch' });
                }
                continue;
            }
            if (block.id !== null) {
                const entry = { id: block.id, config: {}, patchId: block.id, source: 'patch' };
                if (block.name !== null)
                    entry.name = block.name;
                if (block.disabled !== null)
                    entry.disabled = block.disabled;
                entries.push(entry);
            }
        }
    }
    return entries;
}
/** Read every entry from whichever source is available. */
export function readRawEntries(options = {}) {
    const warnings = options.warnings ?? [];
    const fromEditor = entriesFromEditor(options.configEditor, warnings);
    if (fromEditor !== null) {
        return { entries: dedupeRawEntries(fromEditor), source: 'config-editor', warnings };
    }
    const fromPatches = entriesFromPatches(options.patchTexts ?? [], warnings);
    if (fromPatches.length > 0) {
        return { entries: dedupeRawEntries(fromPatches), source: 'patch', warnings };
    }
    return { entries: [], source: 'none', warnings };
}
/**
 * Recover the rows declared inside one `insert:` block.
 *
 * Nested rows are indented two or more spaces under the block; each starts with
 * `- id:` and may carry `name:` and `disabled:` on the lines that follow.
 * Beyond that this path claims nothing: the row's configuration lives in YAML
 * this module deliberately does not re-parse.
 */
function insertRows(blockText) {
    const rows = [];
    let current = null;
    for (const line of blockText.split('\n')) {
        const idMatch = /^\s{2,8}-\s+id:\s*(.+?)\s*$/.exec(line);
        if (idMatch !== null) {
            const raw = (idMatch[1] ?? '').trim();
            const id = raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
            if (id === '') {
                current = null;
                continue;
            }
            current = { id, config: {}, source: 'patch' };
            rows.push(current);
            continue;
        }
        if (current === null)
            continue;
        const nameMatch = /^\s{4,10}name:\s*(.+?)\s*$/.exec(line);
        if (nameMatch !== null) {
            const raw = (nameMatch[1] ?? '').trim();
            current.name = raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
            continue;
        }
        const disabledMatch = /^\s{4,10}disabled:\s*(true|false)\s*$/.exec(line);
        if (disabledMatch !== null)
            current.disabled = disabledMatch[1] === 'true';
    }
    return rows;
}
/** Merge entries that repeat the same id, keeping the later identity fields. */
function dedupeRawEntries(entries) {
    const byId = new Map();
    for (const entry of entries) {
        const existing = byId.get(entry.id);
        if (existing === undefined) {
            byId.set(entry.id, entry);
            continue;
        }
        const merged = {
            ...existing,
            config: { ...existing.config, ...entry.config },
            source: entry.source,
        };
        if (entry.name !== undefined)
            merged.name = entry.name;
        if (entry.patchId !== undefined)
            merged.patchId = entry.patchId;
        if (entry.disabled !== undefined)
            merged.disabled = entry.disabled;
        byId.set(entry.id, merged);
    }
    return [...byId.values()];
}
/**
 * Whether a free-form string carries an embedded credential.
 *
 * `splitSecrets` only sees *keys*, so a password baked into a URL
 * (`https://user:pass@host`) or a raw provider key pasted into a plain field
 * would otherwise reach a synchronized record. Detection reuses the module's
 * scrubber: if redacting the text changes it, the text contains credential
 * material. Over-redacting is the intended bias.
 */
export function isCredentialBearingText(text) {
    return redactText(text) !== text;
}
/**
 * Mask one credential-bearing string while keeping as much of it usable as
 * possible: a URL loses its userinfo (the endpoint stays usable when the
 * server authenticates through headers), anything else becomes `***`.
 */
function maskCredentialText(text) {
    try {
        const url = new URL(text);
        if (url.username !== '' || url.password !== '') {
            url.username = '';
            url.password = '';
            const sanitized = url.toString();
            // A remaining secret (a `?token=` query value) cannot be masked usefully.
            return redactText(sanitized) === sanitized ? sanitized : '***';
        }
    }
    catch {
        // Not a URL.
    }
    return '***';
}
/**
 * Mask strings that embed a credential, recording every masked path.
 *
 * Masking (rather than deleting the key) keeps a mapping's *shape* — an MCP
 * `env` mapping keeps its variable names, which is all the MCP record is
 * allowed to publish — while the value itself never reaches a record. Consumers
 * that must not write a masked value back (plugin configuration) prune every
 * reported path before the value reaches a record.
 */
function scrubCredentialValues(value, prefix, redacted) {
    if (Array.isArray(value)) {
        return value.map((item, index) => {
            const path = `${prefix}[${index}]`;
            if (typeof item === 'string') {
                if (isCredentialBearingText(item)) {
                    redacted.push(path);
                    return maskCredentialText(item);
                }
                return item;
            }
            return scrubCredentialValues(item, path, redacted);
        });
    }
    if (value === null || typeof value !== 'object')
        return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return null;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (typeof item === 'string') {
            if (isCredentialBearingText(item)) {
                redacted.push(path);
                out[key] = maskCredentialText(item);
                continue;
            }
            out[key] = item;
            continue;
        }
        out[key] = scrubCredentialValues(item, path, redacted);
    }
    return out;
}
/**
 * Keys whose mapping values are credential material by nature.
 *
 * `splitSecrets` drops such a key entirely when its value is non-empty, which
 * would erase the variable/header *names* an MCP record must publish. Nulling
 * the values first keeps the mapping's keys (a null is not a secret, so the key
 * survives) while the value never reaches a record. The paths are reported as
 * redacted so a consumer that would write values back can prune them.
 */
const NAME_ONLY_MAPPING = /^(?:env|environment|envs|headers|headerMap)$/i;
/** Null out every value of a name-only mapping (`env`, `headers`). */
function nullNameOnlyMappings(value, prefix, redacted) {
    if (Array.isArray(value))
        return value.map((item, index) => nullNameOnlyMappings(item, `${prefix}[${index}]`, redacted));
    if (value === null || typeof value !== 'object')
        return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (NAME_ONLY_MAPPING.test(key) && isRecordObject(item) && !Array.isArray(item)) {
            const mapping = {};
            for (const name of Object.keys(item)) {
                const childPath = `${path}.${name}`;
                redacted.push(childPath);
                mapping[name] = null;
            }
            out[key] = mapping;
            continue;
        }
        out[key] = nullNameOnlyMappings(item, path, redacted);
    }
    return out;
}
/**
 * Project one raw entry into a secret-free {@link ConfigEntryRecord}.
 *
 * The configuration is first projected through {@link encodeJsExpressions}
 * (which keeps `!!js` values representable), then through `splitSecrets`, then
 * through `sanitizeJson`: the record is therefore lossless JSON and contains no
 * value the redaction rules consider secret.
 */
export function toConfigEntryRecord(entry) {
    const encoded = encodeJsExpressions(entry.config);
    const asObject = isRecordObject(encoded) ? encoded : {};
    const redacted = [];
    const prepared = nullNameOnlyMappings(asObject, '', redacted);
    const { clean, redacted: keyRedacted } = splitSecrets(prepared);
    redacted.push(...keyRedacted);
    const scrubbed = scrubCredentialValues(clean, '', redacted);
    const sanitized = sanitizeJson(scrubbed);
    const config = asJsonObject(sanitized) ?? {};
    const record = {
        id: entry.id,
        config,
        redacted: [...redacted],
    };
    if (entry.name !== undefined)
        record.name = entry.name;
    if (entry.patchId !== undefined)
        record.patchId = entry.patchId;
    if (entry.disabled !== undefined)
        record.disabled = entry.disabled;
    return record;
}
/** Project every raw entry, dropping the ones whose id is unusable. */
export function toConfigEntryRecords(entries, warnings = []) {
    const records = [];
    for (const entry of entries) {
        if (!entry.id || entry.id.includes('\u0000')) {
            warnings.push('跳过了一个没有有效 id 的条目 / skipped an entry with an unusable id');
            continue;
        }
        records.push(toConfigEntryRecord(entry));
    }
    return records;
}
/** A convenient single call for callers that only need records. */
export function readEntryRecords(options = {}) {
    const result = readRawEntries(options);
    const warnings = result.warnings;
    return { entries: toConfigEntryRecords(result.entries, warnings), source: result.source, warnings };
}
/** Whether a record's config carries a plain object under `key`. */
export function configObject(record, key) {
    const value = record.config[key];
    if (!isJsonValue(value))
        return null;
    return asJsonObject(value);
}
