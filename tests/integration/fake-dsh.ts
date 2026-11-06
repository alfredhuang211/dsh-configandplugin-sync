/**
 * A throwaway DSH home for collector tests.
 *
 * Every fake lives under a fresh `mkdtemp` directory and is removed by
 * {@link FakeDsh.cleanup}; nothing touches the real `~/.dsh`. The helper also
 * builds minimal fake Host services (`configEditor`, `pluginManager`) so a test
 * can exercise the service path without a running Harness.
 *
 * The defaults describe the shape a real DSH home has — the home patch, the
 * profile patch, `cordis.yml` and the profile `package.json` — so a test only
 * states the files it cares about.
 * @module tests/integration/fake-dsh
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CollectorServices, JsonValue, SyncLogger } from '../../src/types.js'

/** Description of one fake `node_modules/<name>/package.json`. */
export interface FakeNodeModuleSpec {
  version?: string
  /** Extra fields written into the fake plugin's package.json. */
  fields?: Record<string, unknown>
}

/** Options of {@link createFakeDsh}; every file is optional. */
export interface FakeDshOptions {
  /** Profile name; defaults to `desktop`. */
  profile?: string
  /** Literal home patch text; `null` omits the file, `undefined` uses a comment-only default. */
  homePatch?: string | null
  /** Literal profile patch text; `null` omits the file, `undefined` uses `[]`. */
  profilePatch?: string | null
  /** Literal `cordis.yml`; `null` omits it. */
  cordis?: string | null
  /** Profile `package.json` value; `null` omits it, `undefined` writes a minimal manifest. */
  packageJson?: Record<string, unknown> | null
  /** Literal `.credentials.yaml` text; `null` (the default) omits it. */
  credentials?: string | null
  /** Fake `configEditor.entries()` result; omits the service when undefined. */
  entries?: unknown[] | undefined
  /** Fake `pluginManager.listBundles()` result. */
  bundles?: unknown[] | undefined
  /** Fake `pluginManager.listPlugins()` result. */
  plugins?: unknown[] | undefined
  /** Fake installed packages under the profile's `node_modules`. */
  nodeModules?: Record<string, FakeNodeModuleSpec>
  /** Symlinked packages (`link:` dependencies): name → absolute target directory to create. */
  linkedModules?: Record<string, string>
  /** Extra files, path relative to the DSH home → text. */
  extraFiles?: Record<string, string>
}

/** One fake DSH home. */
export interface FakeDsh {
  /** Absolute DSH home. */
  root: string
  /** `<root>/profiles`. */
  profilesRoot: string
  /** Profile name. */
  profile: string
  /** Absolute profile directory. */
  profileDir: string
  /** Fake Host services, already populated from the options. */
  services: CollectorServices
  /** Absolute path inside the home for a home-relative path. */
  path(relative: string): string
  /** Write one home-relative text file, creating parents. */
  write(relative: string, content: string): Promise<void>
  /** Read one home-relative text file, or null when missing. */
  read(relative: string): Promise<string | null>
  /** Remove the whole fake home. */
  cleanup(): Promise<void>
}

/** Write a text file, creating its parent directory. */
async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** Write a JSON file with two-space indentation. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Create a fake DSH home. */
export async function createFakeDsh(options: FakeDshOptions = {}): Promise<FakeDsh> {
  const root = await mkdtemp(join(tmpdir(), 'fake-dsh-'))
  const profile = options.profile ?? 'desktop'
  const profilesRoot = join(root, 'profiles')
  const profileDir = join(profilesRoot, profile)
  await mkdir(profileDir, { recursive: true })

  const homePatch = options.homePatch === undefined ? '# home patch\n' : options.homePatch
  if (homePatch !== null) await writeText(join(root, 'cordis.patch.yml'), homePatch)
  const profilePatch = options.profilePatch === undefined ? '[]\n' : options.profilePatch
  if (profilePatch !== null) await writeText(join(profileDir, 'cordis.patch.yml'), profilePatch)
  const cordis = options.cordis === undefined ? '# profile root\n[]\n' : options.cordis
  if (cordis !== null) await writeText(join(profileDir, 'cordis.yml'), cordis)

  const manifest =
    options.packageJson === undefined
      ? {
          name: `dsh-profile-${profile}`,
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [] } },
        }
      : options.packageJson
  if (manifest !== null) await writeJson(join(profileDir, 'package.json'), manifest)

  const credentials = options.credentials === undefined ? null : options.credentials
  if (credentials !== null) await writeText(join(root, '.credentials.yaml'), credentials)

  for (const [name, extra] of Object.entries(options.extraFiles ?? {})) {
    await writeText(join(root, ...name.split('/')), extra)
  }

  const nodeModulesDir = join(profileDir, 'node_modules')
  for (const [name, spec] of Object.entries(options.nodeModules ?? {})) {
    await writeJson(join(nodeModulesDir, ...name.split('/'), 'package.json'), {
      name,
      version: spec.version ?? '1.0.0',
      ...(spec.fields ?? {}),
    })
  }
  for (const [name, target] of Object.entries(options.linkedModules ?? {})) {
    const absoluteTarget = join(root, 'linked', ...target.split('/'))
    await mkdir(absoluteTarget, { recursive: true })
    await writeJson(join(absoluteTarget, 'package.json'), { name, version: '9.9.9-linked' })
    const linkPath = join(nodeModulesDir, ...name.split('/'))
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(absoluteTarget, linkPath, 'dir')
  }

  const services: CollectorServices = {}
  if (options.entries !== undefined) {
    services.configEditor = { entries: () => options.entries }
  }
  if (options.bundles !== undefined || options.plugins !== undefined) {
    services.pluginManager = {
      listBundles: async () => options.bundles ?? [],
      listPlugins: async () => options.plugins ?? [],
    }
  }

  const path = (relative: string): string => join(root, ...relative.split('/'))

  return {
    root,
    profilesRoot,
    profile,
    profileDir,
    services,
    path,
    write: (relative, content) => writeText(path(relative), content),
    read: async relative => {
      try {
        return await readFile(path(relative), 'utf8')
      } catch {
        return null
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** A logger that records everything it is told, for leak assertions. */
export interface RecordingLogger extends SyncLogger {
  /** `level: message` lines, in order. */
  messages: string[]
  /** Every details payload, stringified, in order. */
  payloads: string[]
}

/** Create a logger that keeps every line in memory. */
export function createRecordingLogger(): RecordingLogger {
  const messages: string[] = []
  const payloads: string[] = []
  const push = (level: string, message: string, details?: JsonValue): void => {
    messages.push(`${level}: ${message}`)
    if (details !== undefined) payloads.push(JSON.stringify(details))
  }
  return {
    messages,
    payloads,
    debug: (message, details) => push('debug', message, details),
    info: (message, details) => push('info', message, details),
    warn: (message, details) => push('warn', message, details),
    error: (message, details) => push('error', message, details),
    recent: () => [],
  }
}

/** Seed for the fake patch/entry factories. */
export interface FakeEntrySeed {
  id: string
  name?: string
  patchId?: string
  disabled?: boolean
  config?: Record<string, unknown>
}

/** Build the shape `configEditor.entries()` returns from simple seeds. */
export function fakeEditorEntries(seeds: readonly FakeEntrySeed[]): unknown[] {
  return seeds.map(seed => ({ ...seed, config: seed.config ?? {} }))
}

/** Assertion helper: every recorded logger line (messages and details). */
export function loggerText(logger: RecordingLogger): string {
  return [...logger.messages, ...logger.payloads].join('\n')
}
