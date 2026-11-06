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

import { SCHEMA_VERSION } from '../types.js'
import type { JsonValue, SectionId } from '../types.js'

/** How many snapshots one device keeps per profile. */
export const SNAPSHOT_KEEP = 20

/** One item inside a rollback snapshot: the value and its tombstone flag. */
export interface SnapshotItem {
  value: JsonValue
  deleted?: boolean
  updatedAt: string
  updatedBy: string
}

/** One rollback snapshot document. */
export interface RollbackSnapshot {
  schemaVersion: number
  profile: string
  createdAt: string
  deviceId: string
  deviceName: string
  /** What produced the snapshot (`backup`, `sync`, `restore`). */
  operation: string
  sections: Partial<Record<SectionId, Record<string, SnapshotItem>>>
}

/** Store path of one snapshot. */
export function snapshotPath(profile: string, deviceId: string, createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, '-')
  return `snapshots/${profile}/${deviceId}/${stamp}.json`
}

/** Create a snapshot document from the sections that were just written. */
export function createSnapshot(options: {
  profile: string
  deviceId: string
  deviceName: string
  operation: string
  sections: Partial<Record<SectionId, Record<string, SnapshotItem>>>
  createdAt: string
}): RollbackSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: options.profile,
    createdAt: options.createdAt,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    operation: options.operation,
    sections: options.sections,
  }
}

/** Encode a snapshot for the store. */
export function encodeSnapshot(snapshot: RollbackSnapshot): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(snapshot, null, 2)}\n`)
}

/** Decode a snapshot, returning null when the document is not one. */
export function parseSnapshot(bytes: Uint8Array): RollbackSnapshot | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Partial<RollbackSnapshot>
    if (typeof record.createdAt !== 'string' || typeof record.profile !== 'string') return null
    if (record.sections === null || typeof record.sections !== 'object') return null
    return {
      schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : SCHEMA_VERSION,
      profile: record.profile,
      createdAt: record.createdAt,
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : 'unknown',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : 'unknown',
      operation: typeof record.operation === 'string' ? record.operation : 'unknown',
      sections: record.sections as RollbackSnapshot['sections'],
    }
  } catch {
    return null
  }
}

/**
 * Pick the snapshot paths to delete so one device keeps at most
 * {@link SNAPSHOT_KEEP} per profile.
 *
 * Timestamped file names sort lexicographically in time order, so no parsing is
 * needed; a path from another device or another profile is never touched.
 */
export function pruneSnapshotPaths(paths: readonly string[], profile: string, deviceId: string): string[] {
  const prefix = `snapshots/${profile}/${deviceId}/`
  const mine = paths.filter(path => path.startsWith(prefix) && path.endsWith('.json')).sort()
  if (mine.length <= SNAPSHOT_KEEP) return []
  return mine.slice(0, mine.length - SNAPSHOT_KEEP)
}
