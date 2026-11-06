/**
 * A minimal YAML emitter for lossless JSON, plus a raw-expression escape.
 *
 * This plugin never re-serializes a whole DSH configuration file — that would
 * destroy comments, ordering and `!!js` expressions. It does need to *emit* one
 * new Loader entry (an MCP server, a provider override, a third-party plugin
 * row) that the local profile does not have yet, and for that a small, exact
 * block-style emitter is enough.
 *
 * Only the value shapes a Loader config can hold are supported: maps, lists,
 * strings, finite numbers, booleans and null. Anything else is a programming
 * error and throws instead of being guessed at.
 * @module core/yaml
 */
/** A value that must be emitted verbatim (a `!!js` expression). */
export declare class RawExpression {
    readonly text: string;
    constructor(text: string);
}
/** Value shapes this emitter accepts. */
export type Emittable = RawExpression | string | number | boolean | null | Emittable[] | {
    [key: string]: Emittable;
};
/** Emit one block-style YAML document body (no trailing newline). */
export declare function emitYaml(value: Emittable, baseIndent?: number): string;
/** Emit one patch entry (`- id: ...` block) without a trailing newline. */
export declare function emitPatchEntry(entry: {
    [key: string]: Emittable;
}): string;
