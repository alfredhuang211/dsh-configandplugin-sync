/**
 * The synchronized store: one document per profile section, plus a manifest.
 *
 * This module owns the on-disk layout and nothing else. It never looks at what
 * a section *means*: it reads documents, hands the engine parsed sections, and
 * writes back whatever the engine decided, with a monotonic revision and
 * per-document digests so a status read can tell "changed" from "identical"
 * without parsing everything.
 *
 * Writes are compare-and-set: a backend that notices another device pushed
 * between the read and the write rejects it, and the optional `rebuild`
 * callback lets the engine merge again against the fresh state instead of
 * clobbering it.
 * @module engine/repository
 */
import type { AnyRemoteSection, DeviceSnapshotDocument, SectionId, StoreManifest, StoreSnapshot, StoreWriteResult, SyncBackend, SyncLogger } from '../types.js';
/** File names inside the store. */
export declare const STORE_FILES: {
    readonly manifest: "manifest.json";
    readonly devicePrefix: "devices/";
    readonly profilePrefix: "profiles/";
};
/** Everything one read produced. */
export interface StoreContents {
    /** Store revision reported by the backend. */
    revision: string | null;
    /** Raw documents by store-relative path. */
    files: Map<string, Uint8Array>;
    /** Parsed root manifest, or null while the store is empty. */
    manifest: StoreManifest | null;
    /** profile name → section id → parsed section. */
    profiles: Map<string, Map<SectionId, AnyRemoteSection>>;
    /** device id → last pushed snapshot. */
    devices: Map<string, DeviceSnapshotDocument>;
}
/** One change the engine wants written. */
export interface StoreChange {
    profile: string;
    /** Sections to replace wholesale. A section the engine did not touch is preserved. */
    sections: Partial<Record<SectionId, AnyRemoteSection>>;
    /** Device snapshot to store. */
    device?: DeviceSnapshotDocument;
    /** Extra documents the engine produces (rollback snapshots). */
    extraFiles?: Map<string, Uint8Array>;
    /** Extra store-relative paths to delete. */
    extraDeletions?: string[];
    /** Commit subject or write note. */
    message: string;
    /** Trailers recorded with the write. */
    trailers: Record<string, string>;
    /**
     * Recompute the change against a freshly read store after a concurrent
     * write was detected. Returning null abandons the write with the conflict.
     */
    rebuild?: (contents: StoreContents) => Promise<StoreChange | null>;
    /** Skip the actual write (dry run). */
    dryRun?: boolean;
    signal?: AbortSignal;
}
/** Read and write a synchronized store. */
export interface Repository {
    read(signal?: AbortSignal): Promise<StoreContents>;
    write(change: StoreChange): Promise<StoreWriteResult>;
}
/** Create a repository over one backend. */
export declare function createRepository(options: {
    backend: SyncBackend;
    logger: SyncLogger;
    generator: {
        name: string;
        version: string;
    };
    now?: () => Date;
}): Repository;
/** Parse a raw backend snapshot into typed documents. */
export declare function parseContents(snapshot: StoreSnapshot, logger: SyncLogger): StoreContents;
/** Store path of one section document. */
export declare function sectionPath(profile: string, section: SectionId): string;
/** Fingerprint of the whole document set, for a status read that avoids parsing. */
export declare function contentsDigest(contents: StoreContents): string;
/** Narrow a section document to its items, defaulting to an empty map. */
export declare function sectionItems<T>(document: AnyRemoteSection | undefined): Record<string, {
    value: T;
    deleted?: boolean;
    updatedAt: string;
    updatedBy: string;
}>;
