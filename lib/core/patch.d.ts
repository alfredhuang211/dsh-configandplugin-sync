/**
 * Loader patch file surgery.
 *
 * A profile patch is a top-level YAML array of entries. This module splits the
 * file into verbatim text blocks — never re-serializing anything it keeps — so
 * comments, blank lines and `!!js` expressions survive a merge, then matches
 * blocks by entry id to replace exactly the entries a restore decided to take.
 *
 * That is what makes cross-device configuration restore safe: an entry the
 * remote did not touch keeps its local text byte for byte, including a comment
 * the user just wrote.
 * @module core/patch
 */
import type { Emittable } from './yaml.js';
/** How one block came into being. */
export type PatchBlockKind = 'override' | 'insert' | 'unknown';
/** One top-level item of a patch file. */
export interface PatchBlock {
    kind: PatchBlockKind;
    /** Entry id for an override block. */
    id: string | null;
    /** Entry ids declared inside an `insert:` block, in order. */
    insertIds: string[];
    /** Module/package name, when the first line exposes it. */
    name: string | null;
    /** Loader `disabled:` flag, when the block sets one. */
    disabled: boolean | null;
    /** Verbatim text of the block, including comments attached above it. */
    text: string;
}
/** A patch file split into its preamble and its blocks. */
export interface SplitPatch {
    /** Leading comments and blank lines before the first entry. */
    preamble: string;
    blocks: PatchBlock[];
}
/** Split a patch file into verbatim blocks. */
export declare function splitPatch(text: string): SplitPatch;
/** Every entry id a patch declares, including ids nested in `insert:` blocks. */
export declare function patchEntryIds(split: SplitPatch): Set<string>;
/** Find the block that declares one entry id, if any. */
export declare function findBlockForId(split: SplitPatch, id: string): PatchBlock | null;
/** How a merge should treat an entry the two sides disagree about. */
export interface PatchMergePlan {
    /**
     * Entry ids to take from the incoming side. A block that declares a wanted id
     * is replaced wholesale; a block that declares no wanted id keeps its local
     * text.
     */
    takeIds: readonly string[];
    /** Entries to append when the local patch has no block for them. */
    additions?: ReadonlyArray<{
        id: string;
        entry: {
            [key: string]: Emittable;
        };
    }>;
    /** Entry ids to drop from the local patch (only on an explicit removal). */
    dropIds?: readonly string[];
}
/** Result of merging two patch documents. */
export interface PatchMergeResult {
    text: string;
    /** Entry ids whose local text changed. */
    changedIds: string[];
    /** Entry ids that were appended because they were missing locally. */
    addedIds: string[];
    /** Entry ids that were removed. */
    removedIds: string[];
}
/**
 * Merge incoming blocks into a local patch.
 *
 * Kept blocks are copied verbatim. Replacement uses the incoming block's own
 * text, which the caller usually takes from the remote document, so a restore
 * reproduces exactly what the other device wrote — including `!!js` expressions
 * that a parsed representation would have flattened.
 */
export declare function mergePatch(localText: string, incomingText: string, plan: PatchMergePlan): PatchMergeResult;
/** Replace one whole entry block with new text built from a value, in place. */
export declare function upsertBlock(text: string, id: string, entry: {
    [key: string]: Emittable;
}): string;
/** Remove one entry id from a patch document. */
export declare function removeBlock(text: string, id: string): string;
/** Restore outcome for masked values. */
export interface MaskRestoreResult {
    text: string;
    /** Keys whose local value was put back. */
    restored: string[];
    /** Keys that stayed masked because no local value existed. */
    unresolved: string[];
}
/**
 * Put local values back where a merged document carries a mask placeholder.
 *
 * The collector masks secret-looking values in the configuration text it
 * synchronizes, which is what keeps a hardcoded password out of the store. A
 * restore must therefore not write `***` over the value this device already
 * has: for every masked line, the local document's value for the same key at
 * the same indentation is restored. When there is no local value the mask stays,
 * and the caller reports it so the user knows to fill it in (or, better, move it
 * into the credential store).
 *
 * A substitution only happens when the local candidate is unambiguous: two
 * different local values for the same key and indentation are left alone rather
 * than guessed at.
 */
export declare function preserveMaskedValues(localText: string, mergedText: string): MaskRestoreResult;
