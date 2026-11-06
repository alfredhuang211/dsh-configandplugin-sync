/**
 * Credential-store collection and restore.
 *
 * DSH keeps its secrets in `$DSH_HOME/.credentials.yaml`: a versioned document
 * with a `refs` mapping (environment-variable name → value) and a `records`
 * mapping (credential key → tagged record). This module reads that document and
 * the Host credential seam into a {@link SecretsPayload}, which the engine
 * encrypts before it ever reaches a backend, and writes a payload back on
 * restore.
 *
 * Three rules shape the whole module:
 *
 *  1. **A value never escapes.** Returned records and warnings carry names and
 *     counts only; a value exists only inside `payload.values`/`payload.records`
 *     in memory, on its way into (or out of) the encrypted envelope.
 *  2. **Prefer the Host seam.** When `ctx.credentials` is mounted, references
 *     are resolved through it (its precedence rules are the running ones) and
 *     records are read/written through `modifyRecord`, the seam's only write
 *     path. The file is the fallback and the write target when no seam exists.
 *  3. **Never guess.** The YAML reader below understands the subset this
 *     document uses (block mappings, block sequences, scalars, quoted strings);
 *     anything else fails with a line number, never with the line's content.
 * @module collect/secrets
 */
import type { JsonValue, SecretsPayload, SyncLogger } from '../types.js';
/** A YAML value the minimal reader produces. */
export type MinimalYamlValue = string | number | boolean | null | MinimalYamlValue[] | {
    [key: string]: MinimalYamlValue;
};
/**
 * Failure of the minimal YAML reader.
 *
 * The message carries a line number only: the offending line holds a secret, so
 * quoting it (as a general-purpose YAML parser would) would put that secret in
 * a log or an HTTP error body.
 */
export declare class MinimalYamlError extends Error {
    constructor(message: string);
}
/**
 * Parse the subset of YAML the credentials document uses.
 *
 * Supports block mappings and sequences, plain and quoted scalars, and JSON
 * flow collections. Throws {@link MinimalYamlError} (line number only) on
 * anything else, so a malformed secret document is never half-understood.
 */
export declare function parseMinimalYaml(text: string): MinimalYamlValue;
/** One stored record as the document (or the seam) holds it. */
export interface StoredCredentialRecord {
    key: string;
    kind: 'api-key' | 'grant';
    /** For `grant`: the owner-defined payload. For `api-key`: `{ key?, env? }`. */
    payload: JsonValue;
}
/** Parsed credentials document. */
export interface ParsedCredentialsDocument {
    version: number;
    /** Reference name → value. Secret material; never log it. */
    refs: Map<string, string>;
    records: Map<string, StoredCredentialRecord>;
    /** Top-level keys this module does not manage, preserved on a rewrite. */
    extra: Map<string, MinimalYamlValue>;
    /** Whether the pre-release flat layout (`NAME: value` at the root) was read. */
    legacyFlat: boolean;
}
/** Whether a name can be a synchronized reference. */
export declare function isCredentialReference(name: string): boolean;
/** Whether a key can be a synchronized record. */
export declare function isCredentialRecordKey(key: string): boolean;
/**
 * Parse one credentials document.
 *
 * Rejects a document it cannot prove it understands with a line number (never
 * the line's content), so a restore never rewrites a file this module only
 * half-read.
 */
export declare function parseCredentialsDocument(text: string): ParsedCredentialsDocument;
/** Serialize a credentials document in the version-1 layout. */
export declare function serializeCredentialsDocument(document: ParsedCredentialsDocument): string;
/** Options of {@link readSecrets}. */
export interface SecretsReadOptions {
    /** Absolute DSH home; used to locate the credentials document. */
    dshHome?: string;
    /** Explicit credentials document path; overrides `dshHome`. */
    credentialsPath?: string;
    /** `ctx.credentials`, feature-detected. */
    credentials?: unknown;
    /**
     * Reference names the profile's configuration points at (provider
     * `apiKeyEnv` values, …). The seam has no reference enumeration, so this is
     * how an environment-only reference is discovered.
     */
    candidateRefs?: readonly string[];
    /** Environment source; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Logger; receives counts and names, never values. */
    logger?: SyncLogger;
}
/** Result of reading the secret slice. */
export interface SecretsReadResult {
    payload: SecretsPayload;
    warnings: string[];
}
/** Resolve the credentials document path. */
export declare function credentialsDocumentPath(options?: {
    dshHome?: string;
    credentialsPath?: string;
}): string;
/**
 * Read the secret slice.
 *
 * The Host seam is consulted first for reference values; the document provides
 * the durable store values and the records. Only store-backed references carry
 * a value: an environment-only reference is recorded as such (so another device
 * knows the profile needs that variable) but its value never leaves this
 * process — it might be a CI secret that must not reach a shared store.
 *
 * @throws SyncError('invalid-config') when the document exists but cannot be
 * parsed; the error names a line, never the line's content.
 */
export declare function readSecrets(options?: SecretsReadOptions): Promise<SecretsReadResult>;
/** Options of {@link writeSecrets}. */
export interface SecretsWriteOptions {
    /** `ctx.credentials`, feature-detected; preferred over the file. */
    credentials?: unknown;
    /** Credentials document path, used when no seam is mounted. */
    credentialsPath: string;
    /** Logger; receives counts and names, never values. */
    logger?: SyncLogger;
}
/** Result of restoring the secret slice. */
export interface SecretsWriteResult {
    /** References written. */
    updatedRefs: string[];
    /** Credential records written. */
    updatedRecords: string[];
    /** Names skipped, with the reason category only. */
    skipped: string[];
    warnings: string[];
}
/**
 * Write the secret slice back onto this device.
 *
 * The Host seam is preferred when it is mounted: references go through
 * `set`, records through `modifyRecord` (its only write path). Without a seam
 * the credentials document is rewritten atomically at mode 0600, preserving
 * every reference, record and top-level key the payload does not mention.
 *
 * Values never appear in a warning: a failed write is reported by reference
 * name and a coarse reason only.
 */
export declare function writeSecrets(payload: SecretsPayload, options: SecretsWriteOptions): Promise<SecretsWriteResult>;
