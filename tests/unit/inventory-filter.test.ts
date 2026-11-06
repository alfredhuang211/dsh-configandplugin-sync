/**
 * The plugin inventory lists post-installed plugins only.
 *
 * DeepSeek's built-in bundles are not something a user installs or
 * synchronizes; showing them would bury the few plugins a user actually added
 * and imply they travel between devices. They are excluded and only counted.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, isOfficialPlugin } from '../../src/engine/index.js'
import type { ProfileSnapshot } from '../../src/types.js'
import { SCHEMA_VERSION } from '../../src/types.js'
import { ConfigStore, StateStore, ensureStoreDirs, normalizeConfig, resolveStorePaths } from '../../src/state/store.js'
import { createNullLogger } from '../../src/core/logger.js'
import { createMemoryBackend } from '../helpers/memory-backend.js'
import { makeSnapshot } from '../helpers/snapshot.js'

const logger = createNullLogger()
const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

async function makeEngineWith(snapshot: ProfileSnapshot) {
  const root = await mkdtemp(join(tmpdir(), 'inventory-test-'))
  roots.push(root)
  const paths = resolveStorePaths(root)
  await ensureStoreDirs(paths)
  const availableProfiles = ['desktop']
  const configStore = new ConfigStore(paths.configPath, input => normalizeConfig(input, 'desktop', availableProfiles))
  const device = snapshot.device
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
  const collector = {
    collect: async () => snapshot,
  }
  return createEngine({
    logger,
    configStore,
    stateStore,
    paths,
    dshHome: root,
    profilesRoot: join(root, 'profiles'),
    activeProfile: 'desktop',
    availableProfiles,
    pluginVersion: '0.1.0',
    dshVersion: '0.2.2',
    device,
    env: {},
    collector,
    services: {},
    createBackend: () => createMemoryBackend(),
  })
}

describe('plugin inventory', () => {
  it('lists post-installed plugins and counts the hidden official ones', async () => {
    const snapshot = makeSnapshot({
      plugins: [
        { id: '@deepseek-ai/dsh-mcp-client', name: '@deepseek-ai/dsh-mcp-client', version: '0.2.2', origin: 'official', builtIn: true, syncable: false },
        { id: 'cordis:include', name: 'cordis:include', version: '0.2.2', origin: 'official', builtIn: true, syncable: false },
        { id: 'dsh-context', name: 'dsh-context', version: '0.81.2', origin: 'npm' },
        { id: 'dsh-codex-session', name: 'dsh-codex-session', version: '0.1.0', origin: 'git', installSpec: 'github:alfredhuang211/dsh-codex-session' },
        { id: 'local:my-plugin', name: 'my-plugin', version: '9.9.9', origin: 'local-path', installSpec: null, restorable: false },
      ],
    })
    const engine = await makeEngineWith(snapshot)
    const inventory = await engine.inventory()
    expect(inventory.plugins.map(plugin => plugin.name)).toEqual(['dsh-context', 'dsh-codex-session', 'my-plugin'])
    expect(inventory.hiddenOfficialPlugins).toBe(2)
    // The official bundles are gone from the list, not silently mixed in.
    expect(inventory.plugins.some(plugin => plugin.builtIn)).toBe(false)
    expect(inventory.plugins.some(plugin => plugin.origin === 'official')).toBe(false)
  })

  it('reports zero hidden bundles when every plugin is post-installed', async () => {
    const engine = await makeEngineWith(makeSnapshot({ plugins: [{ id: 'dsh-context', name: 'dsh-context', origin: 'npm' }] }))
    const inventory = await engine.inventory()
    expect(inventory.hiddenOfficialPlugins).toBe(0)
    expect(inventory.plugins).toHaveLength(1)
  })
})

describe('isOfficialPlugin', () => {
  it('treats a built-in bundle or an official origin as official', () => {
    expect(isOfficialPlugin({ builtIn: true })).toBe(true)
    expect(isOfficialPlugin({ origin: 'official' })).toBe(true)
    expect(isOfficialPlugin({ builtIn: false, origin: 'npm' })).toBe(false)
    expect(isOfficialPlugin({})).toBe(false)
    expect(SCHEMA_VERSION).toBe(1)
  })
})
