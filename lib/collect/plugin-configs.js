/**
 * Per-plugin configuration collection.
 *
 * For every third-party plugin this module gathers the configuration its Loader
 * entries carry, merges those entries into one value tree per plugin, and
 * projects the result through the secret rules. Official/built-in bundles are
 * skipped on purpose: their configuration is DSH's own surface, versioned with
 * DSH, and restoring it across versions is more likely to break than to help.
 *
 * The input entries are already secret-free ({@link ConfigEntryRecord}), and
 * this module applies `splitSecrets` once more as defence in depth before a
 * value reaches a record.
 * @module collect/plugin-configs
 */
import { asJsonObject, isJsonValue, sanitizeJson } from '../core/json.js';
import { splitSecrets } from '../core/redact.js';
import { PACKAGE_NAME } from '../constants.js';
import { isJsExpressionString } from './entries.js';
/** Whether a value is a plain JSON object (never an array). */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
/** Deep-merge a value into a target: objects merge, everything else replaces. */
function mergeValue(target, key, value) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
        const merged = { ...existing };
        for (const [childKey, childValue] of Object.entries(value))
            mergeValue(merged, childKey, childValue);
        target[key] = merged;
        return;
    }
    target[key] = value;
}
/**
 * Merge one entry's config into the accumulated plugin value.
 *
 * A serialized `!!js` expression is skipped: the record shape is JSON, and
 * writing the expression back as a string would turn a live expression into a
 * literal the Loader never evaluates.
 */
function mergeConfig(target, config) {
    for (const [key, value] of Object.entries(config)) {
        if (!isJsonValue(value))
            continue;
        if (isJsExpressionString(value))
            continue;
        mergeValue(target, key, value);
    }
}
/** Split a redaction path (`a.b[0].c`) into keys and array indices. */
function pathTokens(path) {
    return path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
}
/**
 * Remove the value at one redaction path from a merged configuration, then drop
 * any container that became empty because its only content was secret.
 *
 * A path ending in an array index drops the whole array: keeping the array but
 * removing one element would shift every later argument, and writing a masked
 * element back on restore would replace a working credential with `***`.
 */
function dropRedactedPath(root, path) {
    const tokens = pathTokens(path);
    if (tokens.length === 0)
        return;
    let last = tokens.length - 1;
    if (/^\[\d+\]$/.test(tokens[last] ?? ''))
        last -= 1;
    if (last < 0)
        return;
    const parents = [root];
    let current = root;
    for (let index = 0; index < last; index += 1) {
        const token = tokens[index];
        let next;
        if (/^\[\d+\]$/.test(token)) {
            if (!Array.isArray(current))
                return;
            next = current[Number(token.slice(1, -1))];
        }
        else {
            if (current === null || typeof current !== 'object' || Array.isArray(current))
                return;
            next = current[token];
        }
        if (next === undefined)
            return;
        parents.push(next);
        current = next;
    }
    const finalToken = tokens[last];
    if (/^\[\d+\]$/.test(finalToken))
        return;
    if (current === null || typeof current !== 'object' || Array.isArray(current))
        return;
    delete current[finalToken];
    for (let depth = parents.length - 1; depth >= 1; depth -= 1) {
        const node = parents[depth];
        if (!isPlainObject(node) || Object.keys(node).length > 0)
            return;
        const parent = parents[depth - 1];
        const token = tokens[depth - 1];
        if (/^\[\d+\]$/.test(token)) {
            if (!Array.isArray(parent))
                return;
            parent.splice(Number(token.slice(1, -1)), 1);
            continue;
        }
        if (parent === null || typeof parent !== 'object' || Array.isArray(parent))
            return;
        delete parent[token];
    }
}
/** Identities an entry may use to belong to one plugin. */
function entryMatchesPlugin(entry, plugin, entryIds) {
    if (entryIds.has(entry.id))
        return true;
    if (entry.patchId !== undefined && entryIds.has(entry.patchId))
        return true;
    const moduleNames = new Set([plugin.name]);
    for (const row of plugin.rows)
        moduleNames.add(row.moduleName);
    if (entry.name !== undefined && moduleNames.has(entry.name))
        return true;
    return false;
}
/**
 * Collect configuration records for the third-party plugins of one profile.
 *
 * A plugin with no matching entries produces no record: there is nothing to
 * restore, and an empty record would read as "reset this plugin's config" to
 * the engine's merge.
 */
export function collectPluginConfigs(plugins, entries, options = {}) {
    const warnings = options.warnings ?? [];
    const records = [];
    for (const plugin of plugins) {
        if (plugin.builtIn || plugin.origin === 'official')
            continue;
        // Never synchronize this tool's own loader configuration.
        if (plugin.name === PACKAGE_NAME)
            continue;
        const entryIds = new Set();
        for (const row of plugin.rows) {
            if (row.entryId !== undefined)
                entryIds.add(row.entryId);
            if (row.rowId !== undefined)
                entryIds.add(row.rowId);
        }
        const matched = entries.filter(entry => entryMatchesPlugin(entry, plugin, entryIds));
        if (matched.length === 0)
            continue;
        const values = {};
        const redacted = new Set();
        for (const entry of matched) {
            for (const path of entry.redacted)
                redacted.add(path);
            const { clean, redacted: extra } = splitSecrets(entry.config);
            for (const path of extra)
                redacted.add(path);
            const sanitized = asJsonObject(sanitizeJson(clean));
            if (sanitized === null)
                continue;
            mergeConfig(values, sanitized);
        }
        // Masked leaves are pruned rather than published: writing `***` back on a
        // restore would replace a working credential with a placeholder.
        for (const path of redacted)
            dropRedactedPath(values, path);
        // A record with no value has nothing to restore, and an engine that
        // replaces the whole entry config would wipe it: emit nothing instead.
        if (Object.keys(values).length === 0)
            continue;
        const record = {
            pluginId: plugin.id,
            moduleName: plugin.name,
            entryIds: matched.map(entry => entry.id),
            values,
            redacted: [...redacted].sort(),
        };
        if (record.redacted.length > 0) {
            warnings.push(`插件 ${plugin.name} 的部分配置像密钥，未同步 / some configuration of ${plugin.name} looks like secret material and was not synchronized`);
        }
        records.push(record);
    }
    // Deterministic order: the snapshot digest must not depend on scan order.
    return records.sort((left, right) => (left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0));
}
