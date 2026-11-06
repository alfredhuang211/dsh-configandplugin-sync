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
/** Whether one configuration path segment names secret material. */
export declare function isSecretKey(key: string): boolean;
/**
 * Walk a configuration tree and split it into synchronizable values and the
 * paths that were dropped.
 *
 * A dropped path is reported as a `.`-joined dotted path so the UI can tell the
 * user exactly what stayed behind instead of silently shrinking their config.
 */
export declare function splitSecrets(value: unknown, prefix?: string, redacted?: string[]): {
    clean: unknown;
    redacted: string[];
};
/** Redact well-known secret shapes anywhere in a free-form string. */
export declare function redactText(text: string): string;
/** Redact every string leaf of a JSON value (used before logging details). */
export declare function redactDetails(value: unknown): unknown;
/** Remove credentials from a URL and keep the rest intact, for display. */
export declare function sanitizeUrl(value: string): string;
/** One normalized fingerprint of a secret reference list, for equality checks. */
export declare function hashRefs(refs: readonly {
    ref: string;
    source: string;
}[]): string;
/** One masked line: the key that was hidden and where it was. */
export interface MaskedSecret {
    key: string;
    line: number;
}
/** Result of {@link maskYamlSecrets}. */
export interface MaskResult {
    text: string;
    masked: MaskedSecret[];
}
/** The placeholder written in place of a masked value. */
export declare const MASK_PLACEHOLDER = "***";
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
export declare function maskYamlSecrets(text: string): MaskResult;
/** Whether a raw mapping value is the mask placeholder. */
export declare function isMaskedValue(value: string): boolean;
