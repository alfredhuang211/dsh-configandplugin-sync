/**
 * Lossless-JSON helpers.
 *
 * A synchronized document may only contain {@link JsonValue}: the tool registry
 * rejects anything else, `JSON.stringify` would silently drop `undefined`, and
 * the Web UI cannot render a non-JSON value. These helpers enforce that at the
 * boundary instead of discovering it later.
 * @module core/json
 */
/** Whether a value is lossless JSON (no `undefined`, `Date`, `Map`, `NaN`, ...). */
export function isJsonValue(value, depth = 0) {
    if (depth > 64)
        return false;
    if (value === null)
        return true;
    const type = typeof value;
    if (type === 'string' || type === 'boolean')
        return true;
    if (type === 'number')
        return Number.isFinite(value);
    if (type !== 'object')
        return false;
    if (Array.isArray(value))
        return value.every(item => isJsonValue(item, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    for (const item of Object.values(value)) {
        if (!isJsonValue(item, depth + 1))
            return false;
    }
    return true;
}
/** Copy a value through JSON so it is detached and lossless. */
export function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
/** Drop every key whose value is not lossless JSON, recursively. */
export function sanitizeJson(value) {
    if (value === null)
        return null;
    const type = typeof value;
    if (type === 'string' || type === 'boolean')
        return value;
    if (type === 'number')
        return Number.isFinite(value) ? value : null;
    if (Array.isArray(value))
        return value.map(item => sanitizeJson(item));
    if (type !== 'object')
        return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return null;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined)
            continue;
        out[key] = sanitizeJson(item);
    }
    return out;
}
/** Order object keys recursively so a digest does not depend on insertion order. */
export function stableJson(value) {
    if (Array.isArray(value))
        return value.map(item => stableJson(item));
    if (value === null || typeof value !== 'object')
        return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        out[key] = stableJson(value[key]);
    }
    return out;
}
/** Compact stable serialization, used for digests and baseline fingerprints. */
export function stableStringify(value) {
    return JSON.stringify(stableJson(value));
}
/** Deep structural equality over lossless JSON. */
export function jsonEqual(left, right) {
    return stableStringify(sanitizeJson(left)) === stableStringify(sanitizeJson(right));
}
/** Parse a JSON document, returning null instead of throwing. */
export function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
/** Narrow an unknown to a JSON object. */
export function asJsonObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return null;
    return sanitizeJson(value);
}
/** Read a string field from an unknown record. */
export function stringField(value, key) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const raw = value[key];
    return typeof raw === 'string' ? raw : undefined;
}
/** Read a boolean field from an unknown record. */
export function booleanField(value, key) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const raw = value[key];
    return typeof raw === 'boolean' ? raw : undefined;
}
