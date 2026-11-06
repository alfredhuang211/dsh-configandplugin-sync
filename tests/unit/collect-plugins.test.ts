/**
 * Collector tests: plugin inventory.
 *
 * The inventory must classify npm / git / link / tarball / official sources,
 * read a version without ever touching plugin code, and fall back from the Host
 * plugin manager to the profile manifest.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createFakeDsh, createRecordingLogger, type FakeDsh } from '../integration/fake-dsh.js'
import { collectPlugins } from '../../src/collect/plugins.js'
import { collectPluginConfigs } from '../../src/collect/plugin-configs.js'
import { toConfigEntryRecord, type RawEntry } from '../../src/collect/entries.js'
import type { ConfigEntryRecord, PluginRecord } from '../../src/types.js'

const homes: FakeDsh[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) await home.cleanup()
  }
})

function track(home: FakeDsh): FakeDsh {
  homes.push(home)
  return home
}

/** Find a record by package name; fails the test when missing. */
function pluginNamed(plugins: readonly PluginRecord[], name: string): PluginRecord {
  const record = plugins.find(candidate => candidate.name === name)
  expect(record, `expected a plugin record for ${name}`).toBeDefined()
  return record as PluginRecord
}

/** Build the entry shape the collector consumes. */
function entry(id: string, name: string | undefined, disabled?: boolean): ConfigEntryRecord {
  const record: ConfigEntryRecord = { id, config: {}, redacted: [] }
  if (name !== undefined) record.name = name
  if (disabled !== undefined) record.disabled = disabled
  return record
}

describe('collectPlugins (profile manifest fallback)', () => {
  it('classifies npm, git, link, tarball and official dependencies', async () => {
    const home = track(
      await createFakeDsh({
        packageJson: {
          dependencies: {
            'dsh-context': '0.81.2',
            'dsh-opencode-session': '^0.1.1',
            'dsh-codex-session': 'github:alfredhuang211/dsh-codex-session',
            'dsh-ai-passport': 'link:linked/ai-passport',
            'dsh-tgz': 'file:/tmp/dsh-tgz-1.0.0.tgz',
            '@deepseek-ai/dsh-base': '^1.0.0',
          },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } },
        },
        nodeModules: {
          'dsh-context': { version: '0.81.2' },
          'dsh-opencode-session': { version: '0.1.5' },
          'dsh-codex-session': { version: '0.3.0' },
          '@deepseek-ai/dsh-base': { version: '1.2.3' },
        },
        linkedModules: { 'dsh-ai-passport': 'ai-passport' },
      }),
    )

    const result = await collectPlugins({
      profile: 'desktop',
      profileDir: home.profileDir,
      dependencies: {
        'dsh-context': '0.81.2',
        'dsh-opencode-session': '^0.1.1',
        'dsh-codex-session': 'github:alfredhuang211/dsh-codex-session',
        'dsh-ai-passport': 'link:linked/ai-passport',
        'dsh-tgz': 'file:/tmp/dsh-tgz-1.0.0.tgz',
        '@deepseek-ai/dsh-base': '^1.0.0',
      },
      platform: 'linux',
    })

    expect(result.source).toBe('profile-manifest')
    const context = pluginNamed(result.plugins, 'dsh-context')
    expect(context.origin).toBe('npm')
    expect(context.version).toBe('0.81.2')
    expect(context.installSpec).toBe('dsh-context@0.81.2')
    expect(context.builtIn).toBe(false)
    expect(context.syncable).toBe(true)
    expect(context.restorable).toBe(true)
    expect(context.profile).toBe('desktop')
    expect(context.platform).toBe('linux')

    const ranged = pluginNamed(result.plugins, 'dsh-opencode-session')
    expect(ranged.version).toBe('0.1.5')
    expect(ranged.installSpec).toBe('dsh-opencode-session@0.1.5')

    const git = pluginNamed(result.plugins, 'dsh-codex-session')
    expect(git.origin).toBe('git')
    expect(git.version).toBe('0.3.0')
    expect(git.installSpec).toBe('github:alfredhuang211/dsh-codex-session')
    expect(git.restorable).toBe(true)

    const linked = pluginNamed(result.plugins, 'dsh-ai-passport')
    expect(linked.origin).toBe('local-path')
    expect(linked.version).toBe('9.9.9-linked')
    expect(linked.installSpec).toBeNull()
    expect(linked.id).toBe('local:dsh-ai-passport')
    expect(linked.syncable).toBe(true)
    expect(linked.restorable).toBe(false)

    const tarball = pluginNamed(result.plugins, 'dsh-tgz')
    expect(tarball.origin).toBe('tarball')
    expect(tarball.installSpec).toBeNull()
    expect(tarball.restorable).toBe(false)

    const builtIn = pluginNamed(result.plugins, '@deepseek-ai/dsh-base')
    expect(builtIn.builtIn).toBe(true)
    expect(builtIn.origin).toBe('official')
    expect(builtIn.installSpec).toBeNull()
    expect(builtIn.syncable).toBe(false)
    expect(builtIn.restorable).toBe(false)

    // Sorted by id and free of duplicates.
    const ids = result.plugins.map(plugin => plugin.id)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reports patch-only plugins and per-row enablement from entry identity', async () => {
    const home = track(
      await createFakeDsh({
        packageJson: { dependencies: { 'dsh-context': '0.81.2' }, dsh: { profile: { bundles: [] } } },
        nodeModules: { 'dsh-context': { version: '0.81.2' } },
      }),
    )

    const result = await collectPlugins({
      profile: 'desktop',
      profileDir: home.profileDir,
      dependencies: { 'dsh-context': '0.81.2' },
      entries: [
        entry('context-entry', 'dsh-context', true),
        entry('extra-entry', 'file:///opt/plugins/extra/plugin.mjs'),
      ],
    })

    const context = pluginNamed(result.plugins, 'dsh-context')
    expect(context.enabled).toBe(false)
    expect(context.rows).toEqual([
      { moduleName: 'dsh-context', enabled: false, entryId: 'context-entry', rowId: 'context-entry' },
    ])

    const extra = pluginNamed(result.plugins, 'file:///opt/plugins/extra/plugin.mjs')
    expect(extra.origin).toBe('local-path')
    expect(extra.builtIn).toBe(false)
    expect(extra.syncable).toBe(true)
    expect(extra.restorable).toBe(false)
    expect(extra.installSpec).toBeNull()
  })

  it('never treats an official patch override as an installed third-party plugin', async () => {
    const home = track(await createFakeDsh())
    const result = await collectPlugins({
      profile: 'desktop',
      profileDir: home.profileDir,
      dependencies: {},
      entries: [entry('ui-chat', '@deepseek-ai/dsh-client-ui-chat')],
    })
    expect(result.plugins).toEqual([])
  })
})

describe('collectPlugins (Host plugin manager)', () => {
  it('uses bundles and plugin rows, including display names and enablement', async () => {
    const home = track(
      await createFakeDsh({
        packageJson: { dependencies: { 'dsh-context': '0.81.2' }, dsh: { profile: { bundles: ['dsh-context'] } } },
        bundles: [
          {
            name: 'dsh-context',
            official: false,
            availability: 'profile',
            version: '0.81.2',
            enabled: true,
            installed: true,
            installTarget: { spec: 'dsh-context@0.81.2', version: '0.81.2' },
            source: 'npm:dsh-context@0.81.2',
            optional: false,
            removable: true,
            rows: [{ rowId: 'context-row', moduleName: 'dsh-context', entryId: 'context-entry' }],
            overrides: [],
          },
          {
            name: '@deepseek-ai/dsh-base',
            official: true,
            availability: 'installation',
            version: '1.0.0',
            enabled: true,
            installed: true,
            rows: [{ rowId: 'base-row', moduleName: '@deepseek-ai/dsh-base', entryId: 'base-entry' }],
            overrides: [],
            optional: false,
            removable: false,
          },
        ],
        plugins: [
          {
            entryId: 'context-entry',
            moduleName: 'dsh-context',
            enabled: false,
            patchId: 'context-row',
            meta: { title: { en: 'Context' } },
          },
          { entryId: 'base-entry', moduleName: '@deepseek-ai/dsh-base', enabled: true },
        ],
      }),
    )

    const result = await collectPlugins({
      profile: 'desktop',
      profileDir: home.profileDir,
      dependencies: { 'dsh-context': '0.81.2' },
      pluginManager: home.services.pluginManager,
    })

    expect(result.source).toBe('plugin-manager')
    const context = pluginNamed(result.plugins, 'dsh-context')
    // Bundle-level enablement comes from the bundle; the row keeps the plugin
    // entry's own state, which is what a per-row toggle changes.
    expect(context.enabled).toBe(true)
    expect(context.displayName).toBe('Context')
    expect(context.installSpec).toBe('dsh-context@0.81.2')
    expect(context.rows).toEqual([
      { moduleName: 'dsh-context', enabled: false, entryId: 'context-entry', rowId: 'context-row' },
    ])

    const base = pluginNamed(result.plugins, '@deepseek-ai/dsh-base')
    expect(base.builtIn).toBe(true)
    expect(base.syncable).toBe(false)
  })

  it('adds an orphan record for a plugin entry no bundle claims', async () => {
    const home = track(
      await createFakeDsh({
        packageJson: { dependencies: { 'dsh-orphan': '2.0.0' }, dsh: { profile: { bundles: [] } } },
        nodeModules: { 'dsh-orphan': { version: '2.0.0' } },
        bundles: [],
        plugins: [{ entryId: 'orphan-entry', moduleName: 'dsh-orphan', enabled: true }],
      }),
    )

    const result = await collectPlugins({
      profile: 'desktop',
      profileDir: home.profileDir,
      dependencies: { 'dsh-orphan': '2.0.0' },
      pluginManager: home.services.pluginManager,
    })

    const orphan = pluginNamed(result.plugins, 'dsh-orphan')
    expect(orphan.installSpec).toBe('dsh-orphan@2.0.0')
    expect(orphan.error).toContain('no matching bundle metadata')
    expect(orphan.rows).toEqual([{ moduleName: 'dsh-orphan', enabled: true, entryId: 'orphan-entry' }])
  })

  it('falls back to the manifest when the plugin manager throws', async () => {
    const home = track(
      await createFakeDsh({
        packageJson: { dependencies: { 'dsh-context': '0.81.2' }, dsh: { profile: { bundles: [] } } },
        nodeModules: { 'dsh-context': { version: '0.81.2' } },
      }),
    )
    const logger = createRecordingLogger()

    const result = await collectPlugins({
      profile: 'desktop',
      profileDir: home.profileDir,
      dependencies: { 'dsh-context': '0.81.2' },
      pluginManager: {
        listBundles: async () => {
          throw new Error('manager exploded with sk-live-secret-value')
        },
        listPlugins: async () => [],
      },
      logger,
    })

    expect(result.source).toBe('profile-manifest')
    expect(result.plugins.map(plugin => plugin.name)).toEqual(['dsh-context'])
    // A failing service produces a warning, not an exception.
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('collectPluginConfigs', () => {
  /** Build the minimal PluginRecord shape the config collector needs. */
  function plugin(id: string, name: string, options: { builtIn?: boolean; entryId?: string } = {}): PluginRecord {
    return {
      id,
      name,
      version: '1.0.0',
      origin: options.builtIn === true ? 'official' : 'npm',
      installSpec: options.builtIn === true ? null : `${name}@1.0.0`,
      enabled: true,
      builtIn: options.builtIn === true,
      syncable: options.builtIn !== true,
      restorable: options.builtIn !== true,
      profile: 'desktop',
      platform: 'linux',
      rows: [{ moduleName: name, enabled: true, ...(options.entryId === undefined ? {} : { entryId: options.entryId }) }],
    }
  }

  /** Build a record the way the entry reader projects one. */
  function entry(id: string, name: string, config: Record<string, unknown>): ConfigEntryRecord {
    const raw: RawEntry = { id, name, config, source: 'config-editor' }
    return toConfigEntryRecord(raw)
  }

  it('merges a third-party plugin config and prunes secret paths', () => {
    const warnings: string[] = []
    const records = collectPluginConfigs(
      [plugin('dsh-context', 'dsh-context', { entryId: 'ctx-entry' })],
      [
        entry('ctx-entry', 'dsh-context', {
          theme: 'dark',
          apiKey: 'sk-plugin-secret-value',
          headers: { Authorization: 'Bearer abcdefghijklmnop' },
          nested: { keep: 1, token: 'nested-secret' },
        }),
      ],
      { warnings },
    )

    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.pluginId).toBe('dsh-context')
    expect(record?.moduleName).toBe('dsh-context')
    expect(record?.entryIds).toEqual(['ctx-entry'])
    expect(record?.values).toEqual({ theme: 'dark', nested: { keep: 1 } })
    expect(record?.redacted).toContain('apiKey')
    expect(record?.redacted).toContain('nested.token')
    expect(record?.redacted).toContain('headers.Authorization')
    expect(JSON.stringify(records)).not.toContain('sk-plugin-secret-value')
    expect(JSON.stringify(records)).not.toContain('nested-secret')
    expect(JSON.stringify(records)).not.toContain('abcdefghijklmnop')
    expect(warnings.some(message => message.includes('dsh-context'))).toBe(true)
  })

  it('skips official bundles and plugins with nothing safe to synchronize', () => {
    const records = collectPluginConfigs(
      [
        plugin('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-base', { builtIn: true, entryId: 'base-entry' }),
        plugin('dsh-secret-only', 'dsh-secret-only', { entryId: 'secret-entry' }),
      ],
      [
        entry('base-entry', '@deepseek-ai/dsh-base', { theme: 'light' }),
        entry('secret-entry', 'dsh-secret-only', { password: 'only-a-secret' }),
      ],
    )
    expect(records).toEqual([])
  })
})
