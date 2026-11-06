/**
 * Secret detection and redaction.
 *
 * Two different jobs live here:
 *
 *  - **detection** decides which configuration paths and MCP arguments are
 *    secret material and must never be written into a synchronized document;
 *  - **redaction** scrubs credentials out of text that leaves the process
 *    (log lines, error messages, URLs shown in the UI).
 *
 * The rules err towards over-redacting: a false positive costs one manual
 * re-entry, a false negative leaks a key into a shared repository.
 * @module core/redact
 */
/** Path segment patterns treated as secret material in a configuration tree. */
const SECRET_KEY_PATTERNS = [
    /(^|[-_.])(api[-_]?key|apikey)($|[-_.])/i,
    /(^|[-_.])(secret|secret[-_]?key)($|[-_.])/i,
    /(^|[-_.])(token|access[-_]?token|refresh[-_]?token|bearer)($|[-_.])/i,
    /(^|[-_.])(password|passwd|pwd)($|[-_.])/i,
    /(^|[-_.])(private[-_]?key|signing[-_]?key|encryption[-_]?key)($|[-_.])/i,
    /(^|[-_.])(authorization|auth[-_]?header|credentials?)($|[-_.])/i,
    /(^|[-_.])(client[-_]?secret|session[-_]?secret|cookie)($|[-_.])/i,
    /^sk-[A-Za-z0-9]/, // a value that is literally a provider key
];
/** Path segments that are explicitly *not* secret despite a matching pattern. */
const SAFE_KEY_PATTERNS = [
    /(^|[-_.])(apiKeyEnv|tokenEnvVar|keyEnv|envVar|headerNames?|envNames?|ref|keyRef|secretRef)($|[-_.])/i,
    /(^|[-_.])(maxTokens|tokens|tokenLimit|contextTokens|tokenizer)($|[-_.])/i,
    /(^|[-_.])(tokenCount|usage)($|[-_.])/i,
];
/** Whether one configuration path segment names secret material. */
export function isSecretKey(key) {
    if (SAFE_KEY_PATTERNS.some(pattern => pattern.test(key)))
        return false;
    return SECRET_KEY_PATTERNS.some(pattern => pattern.test(key));
}
/**
 * Walk a configuration tree and split it into synchronizable values and the
 * paths that were dropped.
 *
 * A dropped path is reported as a `.`-joined dotted path so the UI can tell the
 * user exactly what stayed behind instead of silently shrinking their config.
 */
export function splitSecrets(value, prefix = '', redacted = []) {
    if (Array.isArray(value)) {
        const clean = value.map((item, index) => splitSecrets(item, `${prefix}[${index}]`, redacted).clean);
        return { clean, redacted };
    }
    if (value === null || typeof value !== 'object')
        return { clean: value, redacted };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return { clean: null, redacted };
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (isSecretKey(key) && isNonEmptyScalar(item)) {
            redacted.push(path);
            continue;
        }
        const child = splitSecrets(item, path, redacted);
        clean[key] = child.clean;
    }
    return { clean, redacted };
}
/** Whether a value carries anything worth hiding. */
function isNonEmptyScalar(value) {
    if (value === null || value === undefined)
        return false;
    if (typeof value === 'string')
        return value.trim() !== '';
    if (typeof value === 'number' || typeof value === 'boolean')
        return true;
    // An object or array under a secret key is hidden as a whole.
    return true;
}
/** Redact well-known secret shapes anywhere in a free-form string. */
export function redactText(text) {
    let out = text;
    // Provider keys: sk-..., sk-ant-..., ghp_..., xoxb-...
    out = out.replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g, '$1-***');
    out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***');
    out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***');
    // Credentials embedded in a URL userinfo part.
    out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@/\s]+)@/gi, '$1$2:***@');
    // Bearer tokens.
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1***');
    // Common assignment forms: password=..., token: "..."
    out = out.replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/gi, (_match, key, separator, value) => {
        if (value.startsWith('"') || value.startsWith("'"))
            return `${key}${separator}"***"`;
        if (value === '***' || value.includes('***'))
            return `${key}${separator}${value}`;
        return `${key}${separator}***`;
    });
    return out;
}
/** Redact every string leaf of a JSON value (used before logging details). */
export function redactDetails(value) {
    if (typeof value === 'string')
        return redactText(value);
    if (Array.isArray(value))
        return value.map(item => redactDetails(item));
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = isSecretKey(key) ? '***' : redactDetails(item);
        }
        return out;
    }
    return value;
}
/** Remove credentials from a URL and keep the rest intact, for display. */
export function sanitizeUrl(value) {
    const trimmed = value.trim();
    if (trimmed === '')
        return '';
    try {
        const url = new URL(trimmed);
        if (url.password !== '')
            url.password = '***';
        if (url.username !== '')
            url.username = url.username;
        return url.toString();
    }
    catch {
        return redactText(trimmed);
    }
}
/** One normalized fingerprint of a secret reference list, for equality checks. */
export function hashRefs(refs) {
    return refs
        .map(item => `${item.ref}:${item.source}`)
        .sort()
        .join('\u0000');
}
/** The placeholder written in place of a masked value. */
export const MASK_PLACEHOLDER = '***';
/** Match one `key: value` mapping line, keeping indentation and separators. */
const YAML_SECRET_LINE = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*:\s*)(.+)$/;
/**
 * Replace the values of secret-looking keys in a YAML document with a
 * placeholder.
 *
 * A DSH patch file is synchronized as its literal text — that is the only way a
 * restore reproduces comments and `!!js` expressions — so a credential the user
 * hardcoded there would otherwise be uploaded in the clear. Masking keeps the
 * document's shape (and therefore a faithful per-entry merge) while guaranteeing
 * that the value itself never leaves the device. On the way back in,
 * {@link import('./patch.js').preserveMaskedValues} puts the local value back.
 *
 * The mask is deliberately *not* reversible: there is no key material here, and
 * a document that only ever contains `***` cannot be used to recover anything.
 */
export function maskYamlSecrets(text) {
    const masked = [];
    const lines = text.split('\n');
    const out = lines.map((line, index) => {
        const match = YAML_SECRET_LINE.exec(line);
        if (match === null)
            return line;
        const indent = match[1] ?? '';
        const key = match[2] ?? '';
        const separator = match[3] ?? ': ';
        const rawValue = (match[4] ?? '').trim();
        if (rawValue === '' || rawValue === MASK_PLACEHOLDER)
            return line;
        if (rawValue === '|' || rawValue === '>' || rawValue.startsWith('|') || rawValue.startsWith('>'))
            return line;
        if (rawValue.startsWith('!!js '))
            return line;
        // An environment reference is the recommended shape and is not a value.
        if (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(rawValue))
            return line;
        if (!isSecretKey(key))
            return line;
        masked.push({ key, line: index + 1 });
        return `${indent}${key}${separator}"${MASK_PLACEHOLDER}"`;
    });
    return { text: out.join('\n'), masked };
}
/** Whether a raw mapping value is the mask placeholder. */
export function isMaskedValue(value) {
    const trimmed = value.trim();
    return trimmed === MASK_PLACEHOLDER || trimmed === `"${MASK_PLACEHOLDER}"` || trimmed === `'${MASK_PLACEHOLDER}'`;
}
