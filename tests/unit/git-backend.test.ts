/**
 * Git backend tests against a real local Git repository.
 *
 * Nothing is mocked: the suite creates a bare repository in a temporary
 * directory, clones it through the backend (which uses the real `git`
 * executable) and exercises reads, commits, trailer parsing, deletions, branch
 * creation, detached work trees and the two-work-tree conflict path that the
 * engine relies on when two devices race.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGitBackend,
  describeGitDestination,
  formatCommitTrailers,
  parseCommitTrailers,
} from '../../src/backends/git.js'
import { createBackend, describeBackend } from '../../src/backends/index.js'
import { createNullLogger } from '../../src/core/logger.js'
import { SyncError } from '../../src/core/errors.js'
import type { CommitTrailers, GitBackendConfig, SyncBackend } from '../../src/types.js'

const execFileAsync = promisify(execFile)

/** Run one git command in a specific directory and return stdout. */
async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout
}

/** Encode text as UTF-8 bytes. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Decode bytes as UTF-8 text. */
function text(bytes: Uint8Array | undefined): string {
  return Buffer.from(bytes ?? new Uint8Array()).toString('utf8')
}

/** Canonical trailers of one write. */
function trailers(overrides: Partial<CommitTrailers> = {}): CommitTrailers {
  return {
    operation: 'backup',
    deviceId: 'device-a',
    deviceName: 'Laptop A',
    profile: 'desktop',
    result: 'ok',
    itemCount: '2',
    ...overrides,
  }
}

describe('git backend', () => {
  const roots: string[] = []
  let root: string
  let remote: string
  let workA: string
  let workB: string

  /** Build one backend over the shared bare repository. */
  const makeBackend = (
    workDir: string,
    overrides: Partial<GitBackendConfig> = {},
    storePath = 'store',
  ): SyncBackend => {
    const config: GitBackendConfig = {
      kind: 'git',
      repoUrl: remote,
      branch: 'main',
      authMode: 'credential-helper',
      tokenEnvVar: '',
      username: '',
      ...overrides,
    }
    return createGitBackend(config, { workDir, storePath, logger: createNullLogger() })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-backend-'))
    roots.push(root)
    remote = join(root, 'remote.git')
    workA = join(root, 'work-a')
    workB = join(root, 'work-b')
    await git(['init', '--bare', '-b', 'main', remote])
  })

  afterEach(async () => {
    while (roots.length > 0) {
      const directory = roots.pop()
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a reachable repository whose branch does not exist yet', async () => {
    const backend = makeBackend(workA)
    const result = await backend.testConnection()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('git')
    expect(result.revision).toBeNull()
    expect(result.authMethod).toBe('credential-helper')
    expect(result.message).toContain('main')
  })

  it('reads an empty repository as revision null and stays idempotent', async () => {
    const backend = makeBackend(workA)
    const first = await backend.read()
    expect(first.revision).toBeNull()
    expect(first.files.size).toBe(0)
    const second = await backend.read()
    expect(second.revision).toBeNull()
    expect(second.files.size).toBe(0)
  })

  it('commits documents with trailers and reads them back', async () => {
    const backend = makeBackend(workA)
    const result = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', utf8('{"revision":1}')],
        ['profiles/desktop/plugins.json', utf8('{"plugins":[]}')],
      ]),
      deletions: [],
      message: 'backup from tests',
      trailers: trailers(),
      expectedRevision: null,
    })
    expect(result.changed).toBe(true)
    expect(result.retried).toBe(false)
    expect(result.changedFiles).toEqual(['manifest.json', 'profiles/desktop/plugins.json'])
    expect(result.revision).toMatch(/^[0-9a-f]{40}$/)

    const snapshot = await backend.read()
    expect(snapshot.revision).toBe(result.revision)
    expect(snapshot.files.size).toBe(2)
    expect(text(snapshot.files.get('manifest.json'))).toBe('{"revision":1}')
    expect(text(snapshot.files.get('profiles/desktop/plugins.json'))).toBe('{"plugins":[]}')

    const history = await backend.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      commit: result.revision,
      operation: 'backup',
      deviceId: 'device-a',
      deviceName: 'Laptop A',
      profile: 'desktop',
      itemCount: 2,
      result: 'ok',
    })
    expect(history[0]?.subject).toBe('backup from tests')
    expect(history[0]?.author).toBe('Laptop A')
  })

  it('makes no commit when the tree is unchanged', async () => {
    const backend = makeBackend(workA)
    const first = await backend.write({
      files: new Map<string, Uint8Array>([['manifest.json', utf8('{"revision":1}')]]),
      deletions: [],
      message: 'first',
      trailers: trailers(),
      expectedRevision: null,
    })
    const second = await backend.write({
      files: new Map<string, Uint8Array>([['manifest.json', utf8('{"revision":1}')]]),
      deletions: [],
      message: 'no change',
      trailers: trailers(),
      expectedRevision: first.revision,
    })
    expect(second.changed).toBe(false)
    expect(second.changedFiles).toEqual([])
    expect(second.revision).toBe(first.revision)
    expect(await backend.history()).toHaveLength(1)
  })

  it('deletes documents', async () => {
    const backend = makeBackend(workA)
    const first = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', utf8('{"revision":1}')],
        ['profiles/desktop/plugins.json', utf8('{"plugins":[]}')],
      ]),
      deletions: [],
      message: 'first',
      trailers: trailers(),
      expectedRevision: null,
    })
    const second = await backend.write({
      files: new Map<string, Uint8Array>([['manifest.json', utf8('{"revision":1}')]]),
      deletions: ['profiles/desktop/plugins.json'],
      message: 'remove the plugin inventory',
      trailers: trailers(),
      expectedRevision: first.revision,
    })
    expect(second.changed).toBe(true)
    expect(second.changedFiles).toEqual(['profiles/desktop/plugins.json'])
    const snapshot = await backend.read()
    expect(snapshot.files.has('profiles/desktop/plugins.json')).toBe(false)
    expect(snapshot.revision).toBe(second.revision)
  })

  it('creates a branch that does not exist yet', async () => {
    const feature = makeBackend(workA, { branch: 'feature' })
    const result = await feature.write({
      files: new Map<string, Uint8Array>([['manifest.json', utf8('{"branch":"feature"}')]]),
      deletions: [],
      message: 'first feature write',
      trailers: trailers(),
      expectedRevision: (await feature.read()).revision,
    })
    expect(result.changed).toBe(true)
    const remoteHeads = await git(['ls-remote', '--heads', remote])
    expect(remoteHeads).toContain('refs/heads/feature')

    const reader = makeBackend(workB, { branch: 'feature' })
    const snapshot = await reader.read()
    expect(snapshot.revision).toBe(result.revision)
    expect(text(snapshot.files.get('manifest.json'))).toBe('{"branch":"feature"}')
  })

  it('rejects a stale expected revision instead of overwriting another device', async () => {
    const a = makeBackend(workA)
    const b = makeBackend(workB)
    const baseRevision = (await a.read()).revision
    expect((await b.read()).revision).toBe(baseRevision)

    const writtenByA = await a.write({
      files: new Map<string, Uint8Array>([['profiles/desktop/plugins.json', utf8('{"plugins":["a"]}')]]),
      deletions: [],
      message: 'write from device a',
      trailers: trailers({ deviceId: 'device-a', deviceName: 'Laptop A' }),
      expectedRevision: baseRevision,
    })
    expect(writtenByA.changed).toBe(true)
    expect(writtenByA.retried).toBe(false)

    // B still believes the store is at `baseRevision`; it must not clobber A.
    await expect(
      b.write({
        files: new Map<string, Uint8Array>([['profiles/desktop/plugins.json', utf8('{"plugins":["b"]}')]]),
        deletions: [],
        message: 'write from device b',
        trailers: trailers({ deviceId: 'device-b', deviceName: 'Laptop B' }),
        expectedRevision: baseRevision,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // A's commit is untouched.
    const afterConflict = await b.read()
    expect(afterConflict.revision).toBe(writtenByA.revision)
    expect(text(afterConflict.files.get('profiles/desktop/plugins.json'))).toBe('{"plugins":["a"]}')

    // The engine re-reads, re-merges and writes again against the fresh revision.
    const merged = await b.write({
      files: new Map<string, Uint8Array>([
        ['profiles/desktop/plugins.json', utf8('{"plugins":["a","b"]}')],
        ['profiles/desktop/mcp.json', utf8('{"servers":[]}')],
      ]),
      deletions: [],
      message: 'merged write from device b',
      trailers: trailers({ deviceId: 'device-b', deviceName: 'Laptop B' }),
      expectedRevision: afterConflict.revision,
    })
    expect(merged.changed).toBe(true)
    const final = await a.read()
    expect(final.revision).toBe(merged.revision)
    expect(text(final.files.get('profiles/desktop/plugins.json'))).toBe('{"plugins":["a","b"]}')
    expect(text(final.files.get('profiles/desktop/mcp.json'))).toBe('{"servers":[]}')
    // A's document is preserved: history only ever fast-forwards.
    const log = await git(['log', '--format=%s', '--reverse', 'refs/heads/main'], remote)
    expect(log.trim().split('\n')).toEqual(['write from device a', 'merged write from device b'])
  })

  it('recovers from a detached work tree', async () => {
    const backend = makeBackend(workA)
    const first = await backend.write({
      files: new Map<string, Uint8Array>([['manifest.json', utf8('{"revision":1}')]]),
      deletions: [],
      message: 'first',
      trailers: trailers(),
      expectedRevision: null,
    })
    await git(['checkout', '--detach'], workA)
    const snapshot = await backend.read()
    expect(snapshot.revision).toBe(first.revision)
    expect(text(snapshot.files.get('manifest.json'))).toBe('{"revision":1}')
  })

  it('refuses a non-empty work directory that is not a git repository', async () => {
    const backend = makeBackend(workA)
    await mkdir(workA, { recursive: true })
    await writeFile(join(workA, 'stray.txt'), 'not a repository', 'utf8')
    await expect(backend.read()).rejects.toMatchObject({ code: 'invalid-config' })
  })

  it('requires a token in https-token mode and never puts it in a message', async () => {
    const missing = createGitBackend(
      {
        kind: 'git',
        repoUrl: 'https://example.invalid/team/repo.git',
        branch: 'main',
        authMode: 'https-token',
        tokenEnvVar: 'DSH_TEST_MISSING_TOKEN',
        username: 'x-access-token',
      },
      { workDir: workA, storePath: 'store', logger: createNullLogger(), tokenProvider: async () => null },
    )
    await expect(missing.read()).rejects.toMatchObject({ code: 'auth-required' })
    await expect(missing.read()).rejects.toThrow(/DSH_TEST_MISSING_TOKEN/)
  })

  it('keeps an https token out of error messages and the destination', async () => {
    const tokenValue = 'super-secret-token-value'
    const backend = createGitBackend(
      {
        kind: 'git',
        // Port 1 refuses immediately, so this stays a fast offline failure.
        repoUrl: 'http://127.0.0.1:1/team/repo.git',
        branch: 'main',
        authMode: 'https-token',
        tokenEnvVar: 'DSH_TEST_TOKEN',
        username: 'x-access-token',
      },
      {
        workDir: workA,
        storePath: 'store',
        logger: createNullLogger(),
        tokenProvider: async () => ({ username: 'x-access-token', token: tokenValue }),
      },
    )
    let failure: unknown
    try {
      await backend.read()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SyncError)
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).not.toContain(tokenValue)
    expect(backend.destination).not.toContain(tokenValue)
  })

  it('rejects a repository URL with embedded credentials', async () => {
    expect(() =>
      describeBackend({
        kind: 'git',
        repoUrl: 'https://user:secret@github.com/team/repo.git',
        branch: 'main',
        authMode: 'credential-helper',
        tokenEnvVar: '',
        username: '',
      }),
    ).toThrowError(SyncError)
    expect(() =>
      describeBackend({
        kind: 'git',
        repoUrl: '',
        branch: 'main',
        authMode: 'credential-helper',
        tokenEnvVar: '',
        username: '',
      }),
    ).toThrowError(SyncError)
    expect(() =>
      describeBackend({
        kind: 'git',
        repoUrl: remote,
        branch: 'bad branch',
        authMode: 'credential-helper',
        tokenEnvVar: '',
        username: '',
      }),
    ).toThrowError(SyncError)
  })

  it('describes the destination without credentials or ssh usernames', () => {
    expect(describeGitDestination({ repoUrl: 'https://github.com/team/repo.git', branch: 'main' }, 'store')).toBe(
      'git https://github.com/team/repo.git#main (store)',
    )
    expect(describeGitDestination({ repoUrl: 'git@github.com:team/repo.git', branch: 'main' })).toBe(
      'git github.com:team/repo.git#main',
    )
    expect(describeGitDestination({ repoUrl: '', branch: '' }, '')).toContain('not configured')
    const description = describeBackend({
      kind: 'git',
      repoUrl: remote,
      branch: 'main',
      authMode: 'credential-helper',
      tokenEnvVar: '',
      username: '',
    })
    expect(description).toMatchObject({ kind: 'git', supportsHistory: true })
    expect(description.destination).not.toContain('secret')
  })

  it('creates the backend through the factory', async () => {
    const created = createBackend(
      {
        kind: 'git',
        repoUrl: remote,
        branch: 'main',
        authMode: 'credential-helper',
        tokenEnvVar: '',
        username: '',
      },
      { workDir: workA, storePath: 'store', logger: createNullLogger() },
    )
    expect(created.kind).toBe('git')
    const result = await created.testConnection()
    expect(result).toMatchObject({ ok: true, kind: 'git' })
  })

  it('cancels an operation when the signal is already aborted', async () => {
    const backend = makeBackend(workA)
    const controller = new AbortController()
    controller.abort()
    await expect(backend.read(controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('reports an unreachable repository as a failed connection instead of throwing', async () => {
    const backend = makeBackend(workA, { repoUrl: join(root, 'does-not-exist.git') })
    const result = await backend.testConnection()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('git')
    expect(result.revision).toBeNull()
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('serializes concurrent preparation of the same work directory', async () => {
    // The engine can run a status read and a diff preview at the same time, and
    // each creates its own backend instance over the same cache directory. Two
    // preparations racing on `git remote`/`fetch`/`reset` used to fail with
    // "remote origin already exists"; the per-work-dir lock makes both succeed.
    const workDir = join(root, 'shared-work')
    const first = makeBackend(workDir)
    const second = makeBackend(workDir)
    const results = await Promise.all([first.read(), second.read(), first.read(), second.read()])
    expect(results).toHaveLength(4)
    for (const snapshot of results) {
      expect(snapshot.revision).toBeNull()
      expect(snapshot.files.size).toBe(0)
    }
  })

  it('round-trips commit trailers', () => {
    const body = formatCommitTrailers(
      trailers({ operation: 'sync', deviceId: 'd-1', deviceName: 'N', profile: 'work', result: 'partial', itemCount: '7' }),
    )
    expect(parseCommitTrailers(body)).toEqual({
      operation: 'sync',
      'device-id': 'd-1',
      'device-name': 'N',
      profile: 'work',
      result: 'partial',
      'item-count': '7',
    })
    expect(parseCommitTrailers('')).toEqual({})
    expect(parseCommitTrailers('subject only')).toEqual({})
  })
})
