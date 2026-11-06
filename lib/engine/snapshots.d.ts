/**
 * Rollback snapshots stored next to the section documents.
 *
 * Git gives history for free, but WebDAV and S3 do not, and "restore what the
 * store looked like yesterday" must not depend on which backend a user picked.
 * Every push therefore writes one compact snapshot of the sections it changed,
 * and `rollback` replays a named snapshot.
 *
 * Snapshots are per device and pruned to the newest {@link SNAPSHOT_KEEP}, so a
 * long-lived store does not grow without bound.
 * @module engine/snapshots
 */
import type { JsonValue, SectionId } from '../types.js';
/** How many snapshots one device keeps per profile. */
export declare const SNAPSHOT_KEEP = 20;
/** One item inside a rollback snapshot: the value and its tombstone flag. */
export interface SnapshotItem {
    value: JsonValue;
    deleted?: boolean;
    updatedAt: string;
    updatedBy: string;
}
/** One rollback snapshot document. */
export interface RollbackSnapshot {
    schemaVersion: number;
    profile: string;
    createdAt: string;
    deviceId: string;
    deviceName: string;
    /** What produced the snapshot (`backup`, `sync`, `restore`). */
    operation: string;
    sections: Partial<Record<SectionId, Record<string, SnapshotItem>>>;
}
/** Store path of one snapshot. */
export declare function snapshotPath(profile: string, deviceId: string, createdAt: string): string;
/** Create a snapshot document from the sections that were just written. */
export declare function createSnapshot(options: {
    profile: string;
    deviceId: string;
    deviceName: string;
    operation: string;
    sections: Partial<Record<SectionId, Record<string, SnapshotItem>>>;
    createdAt: string;
}): RollbackSnapshot;
/** Encode a snapshot for the store. */
export declare function encodeSnapshot(snapshot: RollbackSnapshot): Uint8Array;
/** Decode a snapshot, returning null when the document is not one. */
export declare function parseSnapshot(bytes: Uint8Array): RollbackSnapshot | null;
/**
 * Pick the snapshot paths to delete so one device keeps at most
 * {@link SNAPSHOT_KEEP} per profile.
 *
 * Timestamped file names sort lexicographically in time order, so no parsing is
 * needed; a path from another device or another profile is never touched.
 */
export declare function pruneSnapshotPaths(paths: readonly string[], profile: string, deviceId: string): string[];
