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
import type { Emittable } from '../core/yaml.js';
import type { ConfigEntryRecord, JsonObject } from '../types.js';
/** One entry exactly as read, before redaction. Internal to the collector. */
export interface RawEntry {
    /** Loader entry id (`id:` in the patch or the Host entry). */
    id: string;
    /** Module/package name, when the entry names one. */
    name?: string;
    /** Patch row id that declares the entry, when known. */
    patchId?: string;
    /** Loader `disabled:` flag, when the entry sets one. */
    disabled?: boolean;
    /** Raw configuration object; may still contain `__jsExpr` nodes. */
    config: Record<string, unknown>;
    /** Where the entry was read from. */
    source: 'config-editor' | 'patch';
}
/** Result of reading entries from whichever source is available. */
export interface ReadEntriesResult {
    entries: RawEntry[];
    source: 'config-editor' | 'patch' | 'none';
    warnings: string[];
}
/** Options of {@link readRawEntries}. */
export interface ReadEntriesOptions {
    /** `ctx.configEditor`, feature-detected by the caller. */
    configEditor?: unknown;
    /**
     * Literal patch file texts, in layer order (home patch first, then the
     * profile patch). Used only when the config editor is unavailable.
     */
    patchTexts?: readonly (string | null | undefined)[];
    /** Logger-free warning sink; the caller owns logging. */
    warnings?: string[];
}
/** Prefix marking a serialized `!!js` expression inside a record. */
export declare const JS_EXPRESSION_PREFIX = "!!js ";
/**
 * Project Loader `!!js` nodes into `!!js <expression>` strings.
 *
 * The result stays lossless JSON (which a record must be) and is converted
 * back into a {@link RawExpression} by {@link entryConfigToYamlValue}, so a
 * value that was an expression stays an expression through a restore.
 */
export declare function encodeJsExpressions(value: unknown): unknown;
/** Whether a string is a serialized `!!js` expression. */
export declare function isJsExpressionString(value: unknown): value is string;
/**
 * Convert a record's JSON config into a value the YAML emitter accepts.
 *
 * `!!js <expression>` strings become {@link RawExpression} (emitted verbatim) so
 * a restore writes the expression back instead of quoting it as a literal
 * string. Everything else must already be lossless JSON; non-JSON values are
 * dropped rather than guessed at.
 */
export declare function entryConfigToYamlValue(config: JsonObject | null | undefined): {
    [key: string]: Emittable;
};
/** Convert one lossless JSON value into an emittable value, or undefined to drop it. */
export declare function jsonToEmittable(value: unknown, depth?: number): Emittable | undefined;
/** Read every entry from whichever source is available. */
export declare function readRawEntries(options?: ReadEntriesOptions): ReadEntriesResult;
/**
 * Whether a free-form string carries an embedded credential.
 *
 * `splitSecrets` only sees *keys*, so a password baked into a URL
 * (`https://user:pass@host`) or a raw provider key pasted into a plain field
 * would otherwise reach a synchronized record. Detection reuses the module's
 * scrubber: if redacting the text changes it, the text contains credential
 * material. Over-redacting is the intended bias.
 */
export declare function isCredentialBearingText(text: string): boolean;
/**
 * Project one raw entry into a secret-free {@link ConfigEntryRecord}.
 *
 * The configuration is first projected through {@link encodeJsExpressions}
 * (which keeps `!!js` values representable), then through `splitSecrets`, then
 * through `sanitizeJson`: the record is therefore lossless JSON and contains no
 * value the redaction rules consider secret.
 */
export declare function toConfigEntryRecord(entry: RawEntry): ConfigEntryRecord;
/** Project every raw entry, dropping the ones whose id is unusable. */
export declare function toConfigEntryRecords(entries: readonly RawEntry[], warnings?: string[]): ConfigEntryRecord[];
/** A convenient single call for callers that only need records. */
export declare function readEntryRecords(options?: ReadEntriesOptions): {
    entries: ConfigEntryRecord[];
    source: ReadEntriesResult['source'];
    warnings: string[];
};
/** Whether a record's config carries a plain object under `key`. */
export declare function configObject(record: ConfigEntryRecord, key: string): JsonObject | null;
