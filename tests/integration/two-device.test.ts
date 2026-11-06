/**
 * Two devices, one store.
 *
 * This is the end-to-end contract of the product: device A backs up, device B
 * restores, and the second round is a no-op. It also asserts the two promises
 * that are easy to break silently — no plugin code in the store, and no
 * plaintext secret in the store.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { DshPluginManager } from '../../src/dsh.js'
import type { SyncConfig } from '../../src/types.js'
import { createEngine, type SyncEngine } from '../../src/engine/index.js'
import { createSnapshotCollector } from '../../src/collect/index.js'
import { ConfigStore, StateStore, ensureStoreDirs, normalizeConfig, resolveStorePaths } from '../../src/state/store.js'
import { createNullLogger } from '../../src/core/logger.js'
import { createMemoryBackend } from '../helpers/memory-backend.js'
import { createFakeDsh, type FakeDsh } from './fake-dsh.js'

const logger = createNullLogger()

/** One fake plugin manager that records what it was asked to do. */
interface RecordingManager extends DshPluginManager {
  installs: Array<{ spec: string; enabled: boolean | undefined }>
  toggles: Array<{ id: string; enabled: boolean }>
}

function createRecordingManager(installed: Array<{ entryId: string; moduleName: string; enabled: boolean }>): RecordingManager {
  const installs: RecordingManager['installs'] = []
  const toggles: RecordingManager['toggles'] = []
  return {
    installs,
    toggles,
    async listPlugins() {
      return installed.map(entry => ({
        entryId: entry.entryId,
        moduleName: entry.moduleName,
        enabled: entry.enabled,
        fiberPhase: 'active' as const,
      }))
    },
    async listBundles() {
      return installed.map(entry => ({
        name: entry.moduleName,
        official: false,
        availability: 'profile' as const,
        version: '1.2.3',
        enabled: entry.enabled,
        installed: true,
        optional: false,
        removable: true,
        rows: [],
        overrides: [],
      }))
    },
    async inspect() {
      return { status: 'accepted' as const, kind: 'registry' as const, name: 'x', version: '1.0.0', bundle: true }
    },
    async installBundle(spec, options) {
      installs.push({ spec, enabled: options?.enabled })
      const moduleName = spec.replace(/@[^@/]+$/, '')
      if (!installed.some(entry => entry.moduleName === moduleName)) {
        installed.push({ entryId: `entry-${installs.length}`, moduleName, enabled: options?.enabled ?? true })
      }
      return {
        changed: true,
        application: 'restart-required' as const,
        stage: 'install' as const,
        target: spec,
        version: '1.0.0',
      }
    },
    async removeBundle(name) {
      return { changed: true, application: 'restart-required' as const, stage: 'remove' as const, target: name }
    },
    async setBundleEnabled(name) {
      return { changed: true, application: 'applied' as const, stage: 'enable' as const, target: name }
    },
    async setPluginEnabled(id, enabled) {
      toggles.push({ id, enabled })
      return { changed: true, application: 'applied' as const, stage: 'enable' as const, target: id, enabled }
    },
  } as RecordingManager
}

/**
 * A fake `configEditor` that behaves like the real one for our purposes: it
 * keeps parsed entries and applies an edit through the callback.
 */
function createFakeEditor(
  entries: Array<{ id: string; name?: string; config: Record<string, unknown> }>,
): { entries: () => unknown[]; edit: (entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => Promise<void> } {
  const state = new Map(entries.map(entry => [entry.id, { ...entry }]))
  return {
    entries: () => [...state.values()].map(entry => ({ ...entry, config: structuredClone(entry.config) })),
    edit: async (entry, change) => {
      const target = entry as { id: string; name?: string; config?: Record<string, unknown> }
      const current = structuredClone(state.get(target.id)?.config ?? target.config ?? {})
      const next = change(current, {})
      state.set(target.id, { id: target.id, ...(target.name === undefined ? {} : { name: target.name }), config: next })
    },
  }
}

const PATCH_A = `# device A patch
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      tflow:
        displayName: tflow
        apiKeyEnv: TFLOW_API_KEY
        api: openai-completions
        baseURL: https://tflow.example
        models:
          - id: gpt-6
            name: gpt-6
- id: demo-plugin
  name: demo-plugin
  config:
    feature: on
`

const PATCH_B = `# device B patch
- id: local-only
  name: local-only
  config:
    keep: true
`

const CREDENTIALS_A = `version: 1
refs:
  TFLOW_API_KEY: tf-secret-value
records:
  demo/default:
    kind: grant
    payload:
      token: grant-token
`

interface Harness {
  dsh: FakeDsh
  engine: SyncEngine
  state: StateStore
  config: ConfigStore
  manager: RecordingManager
  env: NodeJS.ProcessEnv
}

async function makeEngine(options: {
  dsh: FakeDsh
  manager: RecordingManager
  backend: ReturnType<typeof createMemoryBackend>
  passphrase?: string
  secrets?: boolean
}): Promise<Harness> {
  const paths = resolveStorePaths(options.dsh.root)
  await ensureStoreDirs(paths)
  const availableProfiles = [options.dsh.profile]
  const configStore = new ConfigStore(paths.configPath, input =>
    normalizeConfig(input, options.dsh.profile, availableProfiles),
  )
  const stateStore = new StateStore(paths.statePath, () => ({
    schemaVersion: 1,
    device: {
      id: `dev_${options.dsh.profile}`,
      name: options.dsh.profile,
      platform: 'darwin',
      arch: 'arm64',
      dshVersion: '0.2.2',
      pluginVersion: '0.1.0',
    },
    lastSyncAt: null,
    lastRevision: null,
    lastOperation: null,
    lastError: null,
    baselines: {},
    conflicts: [],
    connection: null,
    autoSyncFailures: 0,
  }))
  const env: NodeJS.ProcessEnv = { DSH_SYNC_PASSPHRASE: options.passphrase ?? '' }
  const device = {
    id: `dev_${options.dsh.profile}`,
    name: options.dsh.profile,
    platform: 'darwin',
    arch: 'arm64',
    dshVersion: '0.2.2',
    pluginVersion: '0.1.0',
  }
  const services = { ...options.dsh.services, pluginManager: options.manager as unknown as never }
  const config: SyncConfig = {
    ...normalizeConfig(null, options.dsh.profile, availableProfiles),
    backendKind: 'webdav',
    webdav: { kind: 'webdav', url: 'https://dav.example/dsh', username: 'u', password: 'p', token: '' },
    scopes: {
      dshConfig: true,
      providers: true,
      plugins: true,
      pluginConfigs: true,
      secrets: options.secrets === true,
      mcp: true,
    },
  }
  await configStore.write(config)
  const collector = createSnapshotCollector({ device, services, logger })
  const engine = createEngine({
    logger,
    configStore,
    stateStore,
    paths,
    dshHome: options.dsh.root,
    profilesRoot: options.dsh.profilesRoot,
    activeProfile: options.dsh.profile,
    availableProfiles,
    pluginVersion: '0.1.0',
    dshVersion: '0.2.2',
    device,
    env,
    collector,
    services,
    createBackend: () => options.backend,
  })
  return { dsh: options.dsh, engine, state: stateStore, config: configStore, manager: options.manager, env }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('two-device synchronization', () => {
  it('uploads on A, restores on B, and is a no-op on the second round', async () => {
    const backend = createMemoryBackend()
    const dshA = await createFakeDsh({
      profile: 'desktop',
      profilePatch: PATCH_A,
      credentials: CREDENTIALS_A,
      packageJson: {
        name: 'dsh-profile-desktop',
        dependencies: { 'demo-plugin': '1.2.3' },
        dsh: { profile: { bundles: ['demo-plugin'] } },
      },
      plugins: [
        { entryId: 'entry-demo', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' },
      ],
      bundles: [
        { name: 'demo-plugin', official: false, availability: 'profile', version: '1.2.3', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] },
      ],
      entries: [
        {
          id: 'llm-pi-ai',
          name: '@deepseek-ai/dsh-llm-pi-ai',
          config: {
            providers: {
              tflow: {
                displayName: 'tflow',
                apiKeyEnv: 'TFLOW_API_KEY',
                api: 'openai-completions',
                baseURL: 'https://tflow.example',
                models: [{ id: 'gpt-6', name: 'gpt-6' }],
              },
            },
          },
        },
        { id: 'demo-plugin', name: 'demo-plugin', config: { feature: 'on' } },
      ],
    })
    const dshB = await createFakeDsh({ profile: 'desktop', profilePatch: PATCH_B })
    cleanups.push(() => dshA.cleanup(), () => dshB.cleanup())

    const managerA = createRecordingManager([
      { entryId: 'entry-demo', moduleName: 'demo-plugin', enabled: true },
    ])
    const managerB = createRecordingManager([])
    dshB.services.configEditor = createFakeEditor([
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
      { id: 'demo-plugin', name: 'demo-plugin', config: {} },
    ]) as never

    const a = await makeEngine({ dsh: dshA, manager: managerA, backend })
    const b = await makeEngine({ dsh: dshB, manager: managerB, backend })

    // --- A: preview then backup -------------------------------------------------
    const preview = await a.engine.previewSync({})
    expect(preview.plan.direction).toBe('two-way')
    expect(preview.plan.conflicts).toHaveLength(0)
    expect(preview.plan.actions.some(action => action.kind === 'push-dsh-config')).toBe(true)
    expect(preview.plan.actions.some(action => action.kind === 'push-provider')).toBe(true)
    // A local-directory plugin would not be pushed; a registry one is.
    expect(preview.plan.actions.some(action => action.kind === 'push-plugin')).toBe(true)

    const backup = await a.engine.backup({})
    expect(backup.ok).toBe(true)
    expect(backup.pushed).toBe(true)

    const stored = backend.snapshot()
    const paths = Object.keys(stored)
    expect(paths.some(path => path.endsWith('profiles/desktop/providers.json'))).toBe(true)
    expect(paths.some(path => path.endsWith('profiles/desktop/plugins.json'))).toBe(true)
    expect(paths.some(path => path.endsWith('profiles/desktop/dsh-config.json'))).toBe(true)
    // No plugin code, ever.
    expect(paths.some(path => path.includes('node_modules'))).toBe(false)
    expect(paths.some(path => path.endsWith('.tgz'))).toBe(false)
    const pluginDocument = stored['profiles/desktop/plugins.json'] ?? ''
    expect(pluginDocument).toContain('demo-plugin')
    expect(pluginDocument).not.toContain('"main"')
    expect(pluginDocument).not.toContain('module.exports')

    // --- B: restore -------------------------------------------------------------
    const bPreview = await b.engine.previewRestore({})
    expect(bPreview.plan.actions.some(action => action.kind === 'install-plugin')).toBe(true)
    expect(bPreview.plan.actions.some(action => action.kind === 'write-provider')).toBe(true)

    const restore = await b.engine.restore({ confirmDestructive: false })
    expect(restore.ok).toBe(true)
    expect(managerB.installs.map(install => install.spec)).toContain('demo-plugin@1.2.3')
    expect(restore.restartRequired).toBe(true)

    // The provider and the plugin config reached B's profile patch...
    const patchB = (await dshB.read('profiles/desktop/cordis.patch.yml')) ?? ''
    expect(patchB).toContain('baseURL: https://tflow.example')
    // ...without dropping the entry only B had.
    expect(patchB).toContain('local-only')

    // --- second round: converge to nothing -------------------------------------
    const bSecond = await b.engine.previewSync({})
    expect(bSecond.plan.conflicts).toHaveLength(0)
    // B now holds one extra local entry, so the merged document is pushed once...
    await b.engine.sync({})
    // ...and after that both sides agree.
    const aThird = await a.engine.previewSync({})
    expect(aThird.plan.conflicts).toHaveLength(0)
    const bThird = await b.engine.previewSync({})
    expect(bThird.plan.actions).toHaveLength(0)
    expect(bThird.plan.conflicts).toHaveLength(0)
  })

  it('never stores a plaintext secret and restores it on the other device', async () => {
    const backend = createMemoryBackend()
    const dshA = await createFakeDsh({ profile: 'desktop', profilePatch: PATCH_A, credentials: CREDENTIALS_A })
    const dshB = await createFakeDsh({ profile: 'desktop', profilePatch: PATCH_B })
    cleanups.push(() => dshA.cleanup(), () => dshB.cleanup())

    const passphrase = 'a-very-secret-passphrase'
    const a = await makeEngine({ dsh: dshA, manager: createRecordingManager([]), backend, passphrase, secrets: true })
    const b = await makeEngine({ dsh: dshB, manager: createRecordingManager([]), backend, passphrase, secrets: true })

    const backup = await a.engine.backup({})
    expect(backup.ok).toBe(true)

    const stored = backend.snapshot()
    const secretsDocument = stored['profiles/desktop/secrets.json'] ?? ''
    expect(secretsDocument).toContain('"aes-256-gcm"')
    expect(secretsDocument).not.toContain('tf-secret-value')
    expect(secretsDocument).not.toContain('grant-token')
    expect(secretsDocument).not.toContain(passphrase)

    // Presence-only status must not leak a value either.
    const statusB = await b.engine.secretsStatus({})
    expect(statusB.stored).toBe(true)
    expect(JSON.stringify(statusB)).not.toContain('tf-secret-value')

    // Unlocking with the right passphrase works; a wrong one is a typed error.
    await expect(b.engine.unlockSecrets({ passphrase: 'wrong' })).rejects.toMatchObject({ code: 'passphrase-invalid' })
    const unlocked = await b.engine.unlockSecrets({ passphrase })
    expect(unlocked.refCount).toBeGreaterThan(0)

    const restore = await b.engine.restore({})
    expect(restore.ok).toBe(true)
    const credentialsB = (await dshB.read('.credentials.yaml')) ?? ''
    expect(credentialsB).toContain('TFLOW_API_KEY')
    expect(credentialsB).toContain('tf-secret-value')
  })

  it('refuses to execute a plan that still has an unresolved conflict', async () => {
    const backend = createMemoryBackend()
    const dshA = await createFakeDsh({ profile: 'desktop', profilePatch: PATCH_A, entries: [
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { tflow: { displayName: 'tflow', models: ['a'] } } } },
    ] })
    const dshB = await createFakeDsh({ profile: 'desktop', profilePatch: PATCH_B, entries: [
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { tflow: { displayName: 'tflow', models: ['b'] } } } },
    ] })
    cleanups.push(() => dshA.cleanup(), () => dshB.cleanup())

    const a = await makeEngine({ dsh: dshA, manager: createRecordingManager([]), backend })
    await a.engine.backup({})

    const b = await makeEngine({ dsh: dshB, manager: createRecordingManager([]), backend })
    const preview = await b.engine.previewSync({})
    expect(preview.plan.conflicts.length).toBeGreaterThan(0)
    await expect(b.engine.sync({})).rejects.toMatchObject({ code: 'conflict-present' })

    // A resolution unblocks it.
    const resolutions = preview.plan.conflicts.map(conflict => ({
      section: conflict.section,
      id: conflict.id,
      choice: 'local' as const,
    }))
    const result = await b.engine.sync({ resolutions })
    expect(result.ok).toBe(true)
  })

  it('reports a not-configured state without a backend address', async () => {
    const dsh = await createFakeDsh({ profile: 'desktop' })
    cleanups.push(() => dsh.cleanup())
    const backend = createMemoryBackend()
    const harness = await makeEngine({ dsh, manager: createRecordingManager([]), backend })
    await harness.config.write({
      ...(await harness.config.read()),
      webdav: { kind: 'webdav', url: '', username: '', password: '', token: '' },
    })
    const status = await harness.engine.status({})
    expect(status.state).toBe('not-configured')
    expect(status.lastError).toContain('WebDAV')
  })
})
