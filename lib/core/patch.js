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
import { emitPatchEntry } from './yaml.js';
import { isMaskedValue } from './redact.js';
/** Match a top-level sequence item start. */
const ITEM_START = /^-(?:\s|$)/;
/** Match an `id:` at the block's first key position. */
const ENTRY_ID = /^-\s+id:\s*(.+?)\s*$/;
/** Match a `name:` key anywhere in the block (top level or one level in). */
const ENTRY_NAME = /^\s{0,4}name:\s*(.+?)\s*$/;
/** Match a `disabled:` key anywhere in the block. */
const ENTRY_DISABLED = /^\s{0,4}disabled:\s*(true|false)\s*$/;
/** Match a nested row id inside an `insert:` block. */
const INSERT_ROW_ID = /^\s{2,6}-\s+id:\s*(.+?)\s*$/;
/** Split a patch file into verbatim blocks. */
export function splitPatch(text) {
    const lines = text.split('\n');
    const blocks = [];
    let preamble = [];
    let current = null;
    const flush = () => {
        if (current === null)
            return;
        const blockText = current.lines.join('\n').replace(/\s+$/, '');
        if (blockText.trim() !== '')
            blocks.push(describeBlock(blockText));
        current = null;
    };
    for (const line of lines) {
        if (ITEM_START.test(line)) {
            if (current === null) {
                flush();
                current = { start: 0, lines: [line] };
                continue;
            }
            // A comment group separated from the previous block by a blank line
            // belongs to the entry below it, not above it; carrying it keeps the
            // user's comments next to the entry they describe.
            const carried = takeTrailingCommentGroup(current.lines);
            flush();
            current = { start: 0, lines: [...carried, line] };
            continue;
        }
        if (current === null) {
            // Before the first item every line is file-level preamble.
            preamble.push(line);
            continue;
        }
        current.lines.push(line);
    }
    flush();
    return { preamble: trimTrailingBlank(preamble).join('\n'), blocks };
}
/**
 * Move a trailing block of blank lines plus top-level comments off a block.
 *
 * Only a group that starts at a blank line is moved: a comment directly after
 * an entry's last key belongs to that entry.
 */
function takeTrailingCommentGroup(lines) {
    let start = lines.length;
    while (start > 0) {
        const line = lines[start - 1] ?? '';
        if (line.trim() === '' || line.startsWith('#'))
            start -= 1;
        else
            break;
    }
    if (start === lines.length)
        return [];
    const group = lines.slice(start);
    const hasComment = group.some(line => line.startsWith('#'));
    const startsWithBlank = (group[0] ?? '').trim() === '';
    if (!hasComment || !startsWithBlank)
        return [];
    lines.splice(start);
    return group;
}
/** Describe one block's identity from its verbatim text. */
function describeBlock(text) {
    const lines = text.split('\n');
    // Carried leading comments may precede the item line, so find it explicitly.
    const itemIndex = lines.findIndex(line => ITEM_START.test(line));
    const first = itemIndex === -1 ? (lines[0] ?? '') : (lines[itemIndex] ?? '');
    const kind = /^-\s+insert:/.test(first)
        ? 'insert'
        : ENTRY_ID.test(first)
            ? 'override'
            : 'unknown';
    const idMatch = ENTRY_ID.exec(first);
    const id = idMatch === null ? null : unquote(idMatch[1] ?? '');
    const insertIds = [];
    if (kind === 'insert') {
        for (const line of lines) {
            if (ENTRY_ID.test(line))
                continue;
            const match = INSERT_ROW_ID.exec(line);
            if (match !== null) {
                const value = unquote(match[1] ?? '');
                if (value !== '')
                    insertIds.push(value);
            }
        }
    }
    let name = null;
    let disabled = null;
    for (const line of lines.slice(Math.max(0, itemIndex) + 1)) {
        if (name === null) {
            const match = ENTRY_NAME.exec(line);
            if (match !== null)
                name = unquote(match[1] ?? '');
        }
        if (disabled === null) {
            const match = ENTRY_DISABLED.exec(line);
            if (match !== null)
                disabled = match[1] === 'true';
        }
    }
    return { kind, id, insertIds, name, disabled, text };
}
/** Strip surrounding single or double quotes from a scalar. */
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            const inner = trimmed.slice(1, -1);
            return first === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"');
        }
    }
    return trimmed;
}
function trimTrailingBlank(lines) {
    const out = [...lines];
    while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '')
        out.pop();
    return out;
}
/** Every entry id a patch declares, including ids nested in `insert:` blocks. */
export function patchEntryIds(split) {
    const ids = new Set();
    for (const block of split.blocks) {
        if (block.id !== null)
            ids.add(block.id);
        for (const id of block.insertIds)
            ids.add(id);
    }
    return ids;
}
/** Find the block that declares one entry id, if any. */
export function findBlockForId(split, id) {
    for (const block of split.blocks) {
        if (block.id === id)
            return block;
        if (block.insertIds.includes(id))
            return block;
    }
    return null;
}
/**
 * Merge incoming blocks into a local patch.
 *
 * Kept blocks are copied verbatim. Replacement uses the incoming block's own
 * text, which the caller usually takes from the remote document, so a restore
 * reproduces exactly what the other device wrote — including `!!js` expressions
 * that a parsed representation would have flattened.
 */
export function mergePatch(localText, incomingText, plan) {
    const local = splitPatch(localText);
    const incoming = splitPatch(incomingText);
    const take = new Set(plan.takeIds);
    const drop = new Set(plan.dropIds ?? []);
    const changedIds = [];
    const addedIds = [];
    const removedIds = [];
    const blocks = [];
    const covered = new Set();
    for (const block of local.blocks) {
        const ids = [block.id, ...block.insertIds].filter((id) => id !== null && id !== '');
        const dropHit = ids.some(id => drop.has(id));
        if (dropHit) {
            for (const id of ids) {
                if (drop.has(id))
                    removedIds.push(id);
            }
            continue;
        }
        const takeHit = ids.some(id => take.has(id));
        if (!takeHit) {
            blocks.push(block.text);
            continue;
        }
        // Replace with the incoming block that declares the same id; when the
        // incoming side only carries an addition for it, keep the local block and
        // let the addition append instead.
        const replacement = ids
            .map(id => findBlockForId(incoming, id))
            .find((candidate) => candidate !== null && candidate.id === (block.id ?? ''));
        if (replacement === undefined) {
            blocks.push(block.text);
            continue;
        }
        blocks.push(replacement.text);
        for (const id of ids) {
            if (take.has(id)) {
                covered.add(id);
                changedIds.push(id);
            }
        }
    }
    for (const addition of plan.additions ?? []) {
        if (covered.has(addition.id))
            continue;
        const existing = findBlockForId(local, addition.id);
        if (existing !== null)
            continue;
        blocks.push(emitPatchEntry(addition.entry).trim());
        addedIds.push(addition.id);
        covered.add(addition.id);
    }
    // An entry the local file does not have at all but the caller asked to take:
    // append the incoming block verbatim instead of dropping the decision.
    const appended = new Set();
    for (const id of take) {
        if (covered.has(id) || drop.has(id))
            continue;
        if (findBlockForId(local, id) !== null)
            continue;
        const block = findBlockForId(incoming, id);
        if (block === null || appended.has(block.text))
            continue;
        appended.add(block.text);
        blocks.push(block.text);
        addedIds.push(id);
        covered.add(id);
    }
    const parts = [];
    const preamble = local.preamble.trim();
    if (preamble !== '')
        parts.push(preamble);
    if (blocks.length === 0) {
        parts.push('[]');
    }
    else {
        parts.push(blocks.join('\n\n'));
    }
    const text = `${parts.join('\n\n')}\n`;
    return { text, changedIds, addedIds, removedIds };
}
/** Replace one whole entry block with new text built from a value, in place. */
export function upsertBlock(text, id, entry) {
    const split = splitPatch(text);
    const existing = findBlockForId(split, id);
    const serialized = emitPatchEntry(entry).trim();
    if (existing === null) {
        const parts = [];
        const preamble = split.preamble.trim();
        if (preamble !== '')
            parts.push(preamble);
        const blocks = split.blocks.map(block => block.text);
        blocks.push(serialized);
        parts.push(blocks.join('\n\n'));
        return `${parts.join('\n\n')}\n`;
    }
    const blocks = split.blocks.map(block => (block === existing ? serialized : block.text));
    const parts = [];
    const preamble = split.preamble.trim();
    if (preamble !== '')
        parts.push(preamble);
    parts.push(blocks.join('\n\n'));
    return `${parts.join('\n\n')}\n`;
}
/** Remove one entry id from a patch document. */
export function removeBlock(text, id) {
    return mergePatch(text, '', { takeIds: [], dropIds: [id] }).text;
}
// ---------------------------------------------------------------------------
// Masked values
// ---------------------------------------------------------------------------
/** Match one `key: value` mapping line of a patch document. */
const KEY_VALUE_LINE = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*:\s*)(.*)$/;
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
export function preserveMaskedValues(localText, mergedText) {
    const localValues = new Map();
    for (const line of localText.split('\n')) {
        const match = KEY_VALUE_LINE.exec(line);
        if (match === null)
            continue;
        const indent = match[1] ?? '';
        const key = match[2] ?? '';
        const value = (match[4] ?? '').trim();
        if (value === '' || isMaskedValue(value))
            continue;
        const id = `${indent}\u0000${key}`;
        const bucket = localValues.get(id) ?? [];
        bucket.push(value);
        localValues.set(id, bucket);
    }
    const restored = [];
    const unresolved = [];
    const next = mergedText.split('\n').map(line => {
        const match = KEY_VALUE_LINE.exec(line);
        if (match === null)
            return line;
        const value = (match[4] ?? '').trim();
        if (!isMaskedValue(value))
            return line;
        const indent = match[1] ?? '';
        const key = match[2] ?? '';
        const separator = match[3] ?? ': ';
        const candidates = localValues.get(`${indent}\u0000${key}`) ?? [];
        const unique = new Set(candidates);
        if (unique.size === 1 && candidates[0] !== undefined) {
            if (!restored.includes(key))
                restored.push(key);
            return `${indent}${key}${separator}${candidates[0]}`;
        }
        if (!unresolved.includes(key))
            unresolved.push(key);
        return line;
    });
    return { text: next.join('\n'), restored, unresolved };
}
