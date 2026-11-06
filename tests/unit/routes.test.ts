/**
 * The settings-page HTTP surface.
 *
 * These routes are the only way the browser reaches the engine, so the tests
 * here cover the two properties a page can silently break: the envelope every
 * handler must produce, and the rule that storage credentials never leave the
 * Host — including the "empty field means keep the stored value" round trip.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { blankSecrets, registerHttpRoutes, restoreBlankedSecrets, toErrorEnvelope } from '../../src/http/routes.js'
import { API_PREFIX } from '../../src/http/api-types.js'
import type { SyncConfig, SyncConfigView } from '../../src/types.js'
import { normalizeConfig } from '../../src/state/store.js'
import { createEngine, type SyncEngine } from '../../src/engine/index.js'
import { createSnapshotCollector } from '../../src/collect/index.js'
import { ConfigStore, StateStore, ensureStoreDirs, resolveStorePaths } from '../../src/state/store.js'
import { createNullLogger } from '../../src/core/logger.js'
import { SyncError } from '../../src/core/errors.js'
import { createMemoryBackend } from '../helpers/memory-backend.js'
import { createFakeDsh, type FakeDsh } from '../integration/fake-dsh.js'

const logger = createNullLogger()

const PATCH = `# patch
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      tflow:
        displayName: tflow
        apiKeyEnv: TFLOW_API_KEY
        models:
          - id: gpt-6
            name: gpt-6
`

/** Register one route set against a fake connection and return its dispatcher. */
async function makeRouteHarness(): Promise<{
  call: (route: string, body?: unknown) => Promise<{ status: number; payload: any }>
  engine: SyncEngine
  dsh: FakeDsh
  configStore: ConfigStore
}> {
  const dsh = await createFakeDsh({ profile: 'desktop', profilePatch: PATCH })
  const paths = resolveStorePaths(dsh.root)
  await ensureStoreDirs(paths)
  const availableProfiles = ['desktop']
  const configStore = new ConfigStore(paths.configPath, input => normalizeConfig(input, 'desktop', availableProfiles))
  const stateStore = new StateStore(paths.statePath, () => ({
    schemaVersion: 1,
    device: { id: 'dev_test', name: 'test', platform: 'darwin', arch: 'arm64', dshVersion: '0.2.2', pluginVersion: '0.1.0' },
    lastSyncAt: null,
    lastRevision: null,
    lastOperation: null,
    lastError: null,
    baselines: {},
    conflicts: [],
    connection: null,
    autoSyncFailures: 0,
  }))
  const config: SyncConfig = {
    ...normalizeConfig(null, 'desktop', availableProfiles),
    backendKind: 'webdav',
    webdav: {
      kind: 'webdav',
      url: 'https://dav.example/dsh',
      username: 'u',
      password: 'super-secret-password',
      token: 'super-secret-token',
    },
    s3: {
      ...normalizeConfig(null, 'desktop', availableProfiles).s3,
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-access-key',
      sessionToken: 'super-secret-session',
    },
  }
  await configStore.write(config)
  const device = stateStore /* keep the reference alive for lint */
  void device
  const engine = createEngine({
    logger,
    configStore,
    stateStore,
    paths,
    dshHome: dsh.root,
    profilesRoot: dsh.profilesRoot,
    activeProfile: 'desktop',
    availableProfiles,
    pluginVersion: '0.1.0',
    dshVersion: '0.2.2',
    device: { id: 'dev_test', name: 'test', platform: 'darwin', arch: 'arm64', dshVersion: '0.2.2', pluginVersion: '0.1.0' },
    env: {},
    collector: createSnapshotCollector({ services: dsh.services, logger }),
    services: dsh.services,
    createBackend: () => createMemoryBackend(),
  })

  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: () => undefined,
    inject: (_deps: readonly string[], callback: (ctx: unknown) => void) => {
      callback({
        get: () => ({
          fetch: {
            register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
              routes.set(route.path, route.fetch)
              return () => undefined
            },
          },
        }),
      })
      return () => undefined
    },
    effect: () => () => undefined,
    on: () => () => undefined,
    timeout: () => () => undefined,
    interval: () => () => undefined,
  }
  registerHttpRoutes({ ctx: ctx as never, engine, logger })

  const call = async (route: string, body: unknown = {}): Promise<{ status: number; payload: any }> => {
    const handler = routes.get(`${API_PREFIX}/${route}`)
    if (handler === undefined) throw new Error(`route not registered: ${route}`)
    const response = await handler(
      new Request(`http://host${API_PREFIX}/${route}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    )
    return { status: response.status, payload: await response.json() }
  }

  return { call, engine, dsh, configStore }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('route registration', () => {
  it('registers every declared route', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const status = await harness.call('status')
    expect(status.status).toBe(200)
    expect(status.payload.ok).toBe(true)
    // A configured backend with an empty store: local state is ahead.
    expect(status.payload.value.state).toBe('ahead')
    expect(status.payload.value.config.backendKind).toBe('webdav')
  })

  it('answers status with a section card per section', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const { payload } = await harness.call('status', { refresh: false })
    expect(Array.isArray(payload.value.sections)).toBe(true)
    expect(payload.value.sections.map((section: { section: string }) => section.section)).toEqual([
      'dsh-config',
      'providers',
      'plugins',
      'plugin-configs',
      'secrets',
      'mcp',
    ])
  })

  it('exposes the inventory without code or secret values', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    await harness.dsh.write('.credentials.yaml', 'version: 1\nrefs:\n  TFLOW_API_KEY: tf-secret-value\n')
    const { payload } = await harness.call('inventory')
    expect(payload.value.profile).toBe('desktop')
    expect(payload.value.secrets.refs).toBe(1)
    const serialized = JSON.stringify(payload.value)
    expect(serialized).not.toContain('tf-secret-value')
    expect(serialized).not.toContain('module.exports')
  })

  it('returns a typed error envelope for an invalid body', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const handler = `${API_PREFIX}/status`
    expect(handler).toContain('status')
    const { payload } = await harness.call('plugin/inspect', { spec: '' })
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('invalid-config')
  })
})

describe('secret blanking', () => {
  it('blanks every storage credential in a status response', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const { payload } = await harness.call('status')
    expect(payload.value.config.webdav.password).toBe('')
    expect(payload.value.config.webdav.token).toBe('')
    expect(payload.value.config.s3.secretAccessKey).toBe('')
    expect(payload.value.config.s3.sessionToken).toBe('')
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('super-secret')
    // Non-secret fields still travel: the page has to render them.
    expect(payload.value.config.webdav.url).toBe('https://dav.example/dsh')
    expect(payload.value.config.s3.accessKeyId).toBe('AKIAEXAMPLE')
  })

  it('keeps the stored credential when the page submits an empty value', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const before = await harness.call('status')
    const submitted = {
      ...before.payload.value.config,
      webdav: { ...before.payload.value.config.webdav, username: 'changed-user' },
    }
    const saved = await harness.call('config/save', { config: submitted })
    expect(saved.payload.ok).toBe(true)
    const stored = await harness.configStore.read()
    expect(stored.webdav.username).toBe('changed-user')
    // The secret the page never saw is still there.
    expect(stored.webdav.password).toBe('super-secret-password')
    expect(stored.s3.secretAccessKey).toBe('super-secret-access-key')
  })

  it('stores the passphrase in a local 0600 file and reports its source', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const before = await harness.call('secrets/status')
    expect(before.payload.value.passphraseAvailable).toBe(false)

    const saved = await harness.call('secrets/passphrase', { passphrase: 'a-local-passphrase' })
    expect(saved.payload.value.stored).toBe(true)

    const status = await harness.call('secrets/status')
    expect(status.payload.value.passphraseAvailable).toBe(true)
    expect(status.payload.value.passphraseSource).toBe('file')
    // The value itself never appears in a response.
    expect(JSON.stringify(status.payload)).not.toContain('a-local-passphrase')

    const { readFile, stat } = await import('node:fs/promises')
    const file = `${harness.dsh.root}/dsh-configandplugin-sync/passphrase`
    expect((await readFile(file, 'utf8')).trim()).toBe('a-local-passphrase')
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    const cleared = await harness.call('secrets/passphrase', { clear: true })
    expect(cleared.payload.value.stored).toBe(false)
    const after = await harness.call('secrets/status')
    expect(after.payload.value.passphraseAvailable).toBe(false)
  })

  it('rejects an empty passphrase', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const response = await harness.call('secrets/passphrase', { passphrase: '   ' })
    expect(response.payload.ok).toBe(false)
    expect(response.payload.error.code).toBe('passphrase-required')
  })

  it('accepts a newly typed credential', async () => {
    const harness = await makeRouteHarness()
    cleanups.push(() => harness.dsh.cleanup())
    const before = await harness.call('status')
    const submitted = {
      ...before.payload.value.config,
      webdav: { ...before.payload.value.config.webdav, password: 'a-new-password' },
    }
    await harness.call('config/save', { config: submitted })
    const stored = await harness.configStore.read()
    expect(stored.webdav.password).toBe('a-new-password')
  })
})

describe('blankSecrets / restoreBlankedSecrets', () => {
  const view = {
    backendKind: 'git',
    git: { kind: 'git', repoUrl: 'r', branch: 'main', authMode: 'ssh', tokenEnvVar: 'T', username: '' },
    webdav: { kind: 'webdav', url: 'u', username: 'n', password: 'p', token: 't' },
    s3: {
      kind: 's3',
      endpoint: 'e',
      region: 'r',
      bucket: 'b',
      prefix: '',
      accessKeyId: 'a',
      secretAccessKey: 'sk',
      sessionToken: 'st',
      forcePathStyle: true,
    },
    profiles: ['desktop'],
    scopes: { dshConfig: true, providers: true, plugins: true, pluginConfigs: true, secrets: false, mcp: true },
    passphraseEnvVar: 'P',
    excluded: { 'dsh-config': [], providers: [], plugins: [], 'plugin-configs': [], secrets: [], mcp: [] },
    autoSync: {
      enabled: false,
      mode: 'two-way' as const,
      intervalMinutes: 30,
      startupDelayMs: 1,
      onStartup: true,
      onPluginChange: false,
      debounceMs: 1,
    },
    deviceName: 'd',
    passphraseAvailable: false,
    passphraseSource: null,
    tokenAvailable: false,
    device: { id: 'i', name: 'n', platform: 'darwin', arch: 'arm64', dshVersion: '1', pluginVersion: '1' },
    activeProfile: 'desktop',
    availableProfiles: ['desktop'],
    dataDir: '~/.dsh/x',
  } satisfies SyncConfigView

  it('is a pure projection that leaves the input untouched', () => {
    const blanked = blankSecrets(view)
    expect(blanked.webdav.password).toBe('')
    expect(view.webdav.password).toBe('p')
  })

  it('restores an empty field from the stored configuration and keeps a typed one', () => {
    const stored: SyncConfig = view
    const restored = restoreBlankedSecrets(
      { ...view, webdav: { ...view.webdav, password: '', token: 'typed-token' } },
      stored,
    ) as SyncConfig
    expect(restored.webdav.password).toBe('p')
    expect(restored.webdav.token).toBe('typed-token')
  })

  it('maps a thrown SyncError to the wire envelope', () => {
    const envelope = toErrorEnvelope(new SyncError('confirmation-required', '需要确认', { plan: {} }))
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('confirmation-required')
    expect(envelope.error.details).toEqual({ plan: {} })
    expect(toErrorEnvelope(new Error('boom')).error.code).toBe('internal')
  })
})
