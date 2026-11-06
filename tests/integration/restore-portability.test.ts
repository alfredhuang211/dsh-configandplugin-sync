/**
 * A restore must only bring over what the target device can actually use.
 *
 * Device A installs plugins from local paths and carries a `file://` Loader
 * entry for a tool only it has. Device B restores A's state: it must get the
 * portable parts (providers, configuration, portable plugin specs) and must NOT
 * get A's absolute paths — neither as a `file://` Loader entry nor as a
 * `link:`/`file:`/`workspace:` dependency in `package.json`. Copying those would
 * break B's next install and leak A's filesystem layout into B's configuration.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { SyncConfig } from '../../src/types.js'
import { createEngine, type SyncEngine } from '../../src/engine/index.js'
import { createSnapshotCollector } from '../../src/collect/index.js'
import { ConfigStore, StateStore, ensureStoreDirs, normalizeConfig, resolveStorePaths } from '../../src/state/store.js'
import { createNullLogger } from '../../src/core/logger.js'
import { createMemoryBackend } from '../helpers/memory-backend.js'
import { createFakeDsh, type FakeDsh } from './fake-dsh.js'

const logger = createNullLogger()
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

const HOME_PATCH = `# BEGIN DEVICE-A-MANAGED
- insert:
  - id: 'device-a-only-tool'
    name: file:///Users/device-a/.local/plugins/only-here.mjs
# END DEVICE-A-MANAGED
`

const PROFILE_PATCH = `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      tflow:
        displayName: tflow
        apiKeyEnv: TFLOW_API_KEY
        api: openai-completions
        baseURL: https://tflow.online
        models:
          - id: gpt-6
            name: gpt-6
`

const PACKAGE_A = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {
    'dsh-ssh-hosts': 'link:/Users/device-a/plugins/ssh-hosts',
    'dsh-ai-passport': 'link:/Users/device-a/plugins/passport',
    'dsh-context': '0.81.2',
  },
  dsh: { profile: { bundles: ['dsh-context'] } },
}

function manager(installed: Array<{ entryId: string; moduleName: string; enabled: boolean }>): unknown {
  return {
    listPlugins: async () =>
      installed.map(entry => ({
        entryId: entry.entryId,
        moduleName: entry.moduleName,
        enabled: entry.enabled,
        fiberPhase: 'active' as const,
      })),
    listBundles: async () => [],
    inspect: async () => ({ status: 'accepted' as const, kind: 'registry' as const, bundle: true }),
    installBundle: async (spec: string) => ({
      changed: true,
      application: 'applied' as const,
      stage: 'install' as const,
      target: spec,
    }),
    removeBundle: async (name: string) => ({ changed: true, application: 'applied' as const, stage: 'remove' as const, target: name }),
    setBundleEnabled: async (name: string) => ({ changed: true, application: 'applied' as const, stage: 'enable' as const, target: name }),
    setPluginEnabled: async (id: string) => ({ changed: true, application: 'applied' as const, stage: 'enable' as const, target: id }),
  }
}

async function engineFor(
  dsh: FakeDsh,
  backend: ReturnType<typeof createMemoryBackend>,
  options: { ids?: string[] } = {},
): Promise<SyncEngine> {
  const paths = resolveStorePaths(dsh.root)
  await ensureStoreDirs(paths)
  const availableProfiles = [dsh.profile]
  const configStore = new ConfigStore(paths.configPath, input => normalizeConfig(input, dsh.profile, availableProfiles))
  const device = {
    id: `dev_${options.ids?.[0] ?? dsh.profile}`,
    name: options.ids?.[1] ?? dsh.profile,
    platform: 'darwin',
    arch: 'arm64',
    dshVersion: '0.2.2',
    pluginVersion: '0.1.0',
  }
  const stateStore = new StateStore(paths.statePath, () => ({
    schemaVersion: 1,
    device,
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
    ...normalizeConfig(null, dsh.profile, availableProfiles),
    backendKind: 'webdav',
    webdav: { kind: 'webdav', url: 'https://dav.example/dsh', username: 'u', password: 'p', token: '' },
  }
  await configStore.write(config)
  return createEngine({
    logger,
    configStore,
    stateStore,
    paths,
    dshHome: dsh.root,
    profilesRoot: dsh.profilesRoot,
    activeProfile: dsh.profile,
    availableProfiles,
    pluginVersion: '0.1.0',
    dshVersion: '0.2.2',
    device,
    env: {},
    collector: createSnapshotCollector({ services: dsh.services, logger }),
    services: dsh.services,
    createBackend: () => backend,
  })
}

describe('restore portability', () => {
  it('does not copy another device file:// entries or link:/file: dependencies', async () => {
    const backend = createMemoryBackend()

    const deviceA = await createFakeDsh({
      profile: 'desktop',
      homePatch: HOME_PATCH,
      profilePatch: PROFILE_PATCH,
      packageJson: PACKAGE_A,
      plugins: [{ entryId: 'entry-ssh', moduleName: 'dsh-ssh-hosts', enabled: true }],
    })
    // B starts with its own local plugin and its own patch.
    const DEVICE_B_PATCH = '# device B\n- id: local-only\n  name: local-only\n  config:\n    keep: true\n'
    const deviceB = await createFakeDsh({
      profile: 'desktop',
      profilePatch: DEVICE_B_PATCH,
      packageJson: {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      },
    })
    cleanups.push(() => deviceA.cleanup(), () => deviceB.cleanup())
    deviceA.services.pluginManager = manager([{ entryId: 'entry-ssh', moduleName: 'dsh-ssh-hosts', enabled: true }]) as never
    deviceB.services.pluginManager = manager([]) as never

    const a = await engineFor(deviceA, backend)
    const b = await engineFor(deviceB, backend)

    const backup = await a.backup({})
    expect(backup.ok).toBe(true)

    // B restores A's state.
    const preview = await b.previewRestore({})
    expect(preview.plan.conflicts).toHaveLength(0)
    const restore = await b.restore({})
    expect(restore.ok).toBe(true)

    // Portable configuration arrived.
    const profilePatchB = (await deviceB.read('profiles/desktop/cordis.patch.yml')) ?? ''
    expect(profilePatchB).toContain('baseURL: https://tflow.online')
    expect(profilePatchB).toContain('local-only')

    // A's machine-local Loader entry did NOT arrive, and its path did not leak.
    const homePatchB = (await deviceB.read('cordis.patch.yml')) ?? ''
    expect(homePatchB).not.toContain('device-a-only-tool')
    expect(homePatchB).not.toContain('/Users/device-a')
    expect(JSON.stringify(await deviceB.read('cordis.patch.yml'))).not.toContain('/Users/device-a')

    // A's path-shaped dependencies did NOT arrive; the portable one did.
    const packageB = JSON.parse((await deviceB.read('profiles/desktop/package.json')) ?? '{}') as {
      dependencies?: Record<string, string>
    }
    expect(packageB.dependencies?.['dsh-ssh-hosts']).toBeUndefined()
    expect(packageB.dependencies?.['dsh-ai-passport']).toBeUndefined()
    expect(packageB.dependencies?.['dsh-context']).toBe('0.81.2')

    // No absolute path from device A is anywhere in device B's home.
    const bFiles = ['cordis.patch.yml', 'profiles/desktop/cordis.patch.yml', 'profiles/desktop/package.json']
    for (const file of bFiles) {
      const text = (await deviceB.read(file)) ?? ''
      expect(text).not.toContain('/Users/device-a')
    }
  })
})
