/**
 * In-memory {@link SyncBackend} for tests.
 *
 * The engine only talks to a backend through the interface, so the whole
 * read/plan/write cycle can be exercised without a network, a git binary, or a
 * bucket. It also models the one behavior the real backends promise: a write
 * whose `expectedRevision` is stale is rejected as a conflict.
 * @module tests/helpers/memory-backend
 */

import type {
  BackendKind,
  ConnectionTestResult,
  HistoryEntry,
  StoreSnapshot,
  StoreWriteRequest,
  StoreWriteResult,
  SyncBackend,
} from '../../src/types.js'
import { SyncError } from '../../src/core/errors.js'

/** Options of the in-memory backend. */
export interface MemoryBackendOptions {
  kind?: BackendKind
  /** Seed documents, as store-relative paths. */
  files?: Record<string, string>
  destination?: string
}

/** A backend whose whole state lives in a map. */
export interface MemoryBackend extends SyncBackend {
  /** Current store-relative documents. */
  snapshot(): Record<string, string>
  /** Every write the engine performed, newest last. */
  writes(): Array<{ files: string[]; deletions: string[]; message: string; revision: number }>
  /** Force the next write to fail once with a conflict. */
  failNextWriteWithConflict(): void
  /** Simulate another device pushing a document. */
  foreignWrite(path: string, content: string): void
}

/** Create one in-memory backend. */
export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  let files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(options.files ?? {})) {
    files.set(path, new TextEncoder().encode(content))
  }
  let revision = 1
  let conflictOnce = false
  const written: Array<{ files: string[]; deletions: string[]; message: string; revision: number }> = []

  const backend: MemoryBackend = {
    kind: options.kind ?? 'webdav',
    destination: options.destination ?? 'memory://test',

    async read(): Promise<StoreSnapshot> {
      return {
        revision: `r${revision}`,
        files: new Map(files),
      }
    },

    async write(request: StoreWriteRequest): Promise<StoreWriteResult> {
      if (conflictOnce) {
        conflictOnce = false
        throw new SyncError('conflict', 'another device wrote first')
      }
      if (request.expectedRevision !== null && request.expectedRevision !== `r${revision}`) {
        throw new SyncError('conflict', 'stale revision')
      }
      const changedFiles: string[] = []
      for (const [path, data] of request.files) {
        const current = files.get(path)
        const same =
          current !== undefined &&
          current.length === data.length &&
          current.every((byte, index) => byte === data[index])
        if (!same) changedFiles.push(path)
        files.set(path, data)
      }
      for (const path of request.deletions) {
        if (files.delete(path)) changedFiles.push(path)
      }
      revision += 1
      written.push({ files: [...request.files.keys()], deletions: [...request.deletions], message: request.message, revision })
      return { changed: changedFiles.length > 0, revision: `r${revision}`, changedFiles, retried: false }
    },

    async history(): Promise<HistoryEntry[]> {
      return written
        .slice(-20)
        .reverse()
        .map(entry => ({
          commit: `c${entry.revision}`,
          shortCommit: `c${entry.revision}`.slice(0, 7),
          date: new Date(0).toISOString(),
          author: 'test',
          subject: entry.message,
          operation: 'sync',
        }))
    },

    async testConnection(): Promise<ConnectionTestResult> {
      return {
        ok: true,
        at: new Date(0).toISOString(),
        kind: backend.kind,
        revision: `r${revision}`,
        message: 'memory backend',
      }
    },

    snapshot() {
      const out: Record<string, string> = {}
      for (const [path, data] of files) out[path] = new TextDecoder().decode(data)
      return out
    },

    writes() {
      return [...written]
    },

    failNextWriteWithConflict() {
      conflictOnce = true
    },

    foreignWrite(path: string, content: string) {
      files.set(path, new TextEncoder().encode(content))
      revision += 1
    },
  }

  return backend
}
