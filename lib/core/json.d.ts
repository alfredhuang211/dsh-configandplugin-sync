/**
 * Lossless-JSON helpers.
 *
 * A synchronized document may only contain {@link JsonValue}: the tool registry
 * rejects anything else, `JSON.stringify` would silently drop `undefined`, and
 * the Web UI cannot render a non-JSON value. These helpers enforce that at the
 * boundary instead of discovering it later.
 * @module core/json
 */
import type { JsonObject, JsonValue } from '../types.js';
/** Whether a value is lossless JSON (no `undefined`, `Date`, `Map`, `NaN`, ...). */
export declare function isJsonValue(value: unknown, depth?: number): value is JsonValue;
/** Copy a value through JSON so it is detached and lossless. */
export declare function cloneJson<T>(value: T): T;
/** Drop every key whose value is not lossless JSON, recursively. */
export declare function sanitizeJson(value: unknown): JsonValue;
/** Order object keys recursively so a digest does not depend on insertion order. */
export declare function stableJson(value: JsonValue): JsonValue;
/** Compact stable serialization, used for digests and baseline fingerprints. */
export declare function stableStringify(value: JsonValue): string;
/** Deep structural equality over lossless JSON. */
export declare function jsonEqual(left: unknown, right: unknown): boolean;
/** Parse a JSON document, returning null instead of throwing. */
export declare function parseJson<T>(text: string): T | null;
/** Narrow an unknown to a JSON object. */
export declare function asJsonObject(value: unknown): JsonObject | null;
/** Read a string field from an unknown record. */
export declare function stringField(value: unknown, key: string): string | undefined;
/** Read a boolean field from an unknown record. */
export declare function booleanField(value: unknown, key: string): boolean | undefined;
