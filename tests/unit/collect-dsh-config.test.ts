/**
 * Collector tests: DSH configuration files, entries, providers and the
 * end-to-end snapshot.
 *
 * Every test builds its own throwaway DSH home, so the suite is offline and
 * independent of the machine it runs on.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createFakeDsh, createRecordingLogger, fakeEditorEntries, type FakeDsh } from '../integration/fake-dsh.js'
import { collectDshConfig } from '../../src/collect/dsh-config.js'
import { collectProviders } from '../../src/collect/providers.js'
import { createSnapshotCollector } from '../../src/collect/index.js'
import { sha256Text } from '../../src/core/hash.js'
import {
  defaultScopes,
  type CollectorContext,
  type ConfigEntryRecord,
  type DeviceInfo,
  type JsonObject,
  type SectionScopes,
} from '../../src/types.js'

const homes: FakeDsh[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) await home.cleanup()
  }
})

/** Remember a fake home so the suite cleans it up. */
function track(home: FakeDsh): FakeDsh {
  homes.push(home)
  return home
}

/** A complete device identity for snapshot assertions. */
const DEVICE: DeviceInfo = {
  id: 'device-1',
  name: 'Test Device',
  platform: 'linux',
  arch: 'x64',
  dshVersion: '0.2.2-rc.1',
  pluginVersion: '0.1.0',
}

describe('collectDshConfig', () => {
  it('reads the four configuration files verbatim with digests', async () => {
    const homePatch = '# home layer\n- id: home-entry\n  name: dsh-home-thing\n'
    const profilePatch = '# profile layer\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n'
    const cordis = '# root\n[]\n'
    const home = track(
      await createFakeDsh({
        homePatch,
        profilePatch,
        cordis,
        packageJson: {
          dependencies: { 'dsh-context': '0.81.2' },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } },
        },
      }),
    )

    const result = await collectDshConfig({ dshHome: home.root, profilesRoot: home.profilesRoot, profile: 'desktop' })

    expect(result.record.profile).toBe('desktop')
    expect(result.record.files.map(file => file.path)).toEqual([
      'cordis.patch.yml',
      'profiles/desktop/cordis.patch.yml',
      'profiles/desktop/cordis.yml',
      'profiles/desktop/package.json',
    ])
    expect(result.record.files.map(file => file.kind)).toEqual([
      'home-patch',
      'profile-patch',
      'profile-cordis',
      'profile-package',
    ])

    const homeFile = result.record.files[0]
    expect(homeFile?.content).toBe(homePatch)
    expect(homeFile?.sha256).toBe(sha256Text(homePatch))
    expect(homeFile?.size).toBe(Buffer.byteLength(homePatch, 'utf8'))

    expect(result.record.files[1]?.content).toBe(profilePatch)
    expect(result.record.files[2]?.content).toBe(cordis)

    expect(result.record.dependencies).toEqual({ 'dsh-context': '0.81.2' })
    expect(result.record.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(result.profileDir).toBe(home.profileDir)
  })

  it('falls back to patch parsing for entry identity when no config editor exists', async () => {
    const profilePatch = [
      '# a comment survives',
      '- id: ui-chat',
      '  name: "@deepseek-ai/dsh-client-ui-chat"',
      '  config:',
      '    transcriptView: standard',
      '- id: muted-row',
      '  name: dsh-muted',
      '  disabled: true',
      '- insert:',
      '  - id: mcp-github',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '',
    ].join('\n')
    const home = track(await createFakeDsh({ profilePatch }))

    const result = await collectDshConfig({ dshHome: home.root, profilesRoot: home.profilesRoot, profile: 'desktop' })

    expect(result.entriesSource).toBe('patch')
    const ids = result.record.entries.map(entry => entry.id)
    expect(ids).toEqual(['ui-chat', 'muted-row', 'mcp-github'])
    const chat = result.record.entries.find(entry => entry.id === 'ui-chat')
    expect(chat?.name).toBe('@deepseek-ai/dsh-client-ui-chat')
    expect(chat?.patchId).toBe('ui-chat')
    expect(chat?.config).toEqual({})
    const muted = result.record.entries.find(entry => entry.id === 'muted-row')
    expect(muted?.disabled).toBe(true)
    const inserted = result.record.entries.find(entry => entry.id === 'mcp-github')
    expect(inserted?.name).toBe('@deepseek-ai/dsh-mcp-client')
  })

  it('reports missing and malformed files as warnings instead of throwing', async () => {
    const home = track(
      await createFakeDsh({
        profilePatch: null,
        packageJson: null,
      }),
    )
    await home.write('profiles/desktop/cordis.yml', '[]\n')
    await home.write('profiles/desktop/package.json', '{ this is not json\n')

    const result = await collectDshConfig({ dshHome: home.root, profilesRoot: home.profilesRoot, profile: 'desktop' })

    expect(result.record.warnings.some(warning => warning.includes('cordis.patch.yml'))).toBe(true)
    expect(result.record.warnings.some(warning => warning.includes('package.json'))).toBe(true)
    expect(result.record.files.map(file => file.kind)).toEqual(['home-patch', 'profile-cordis', 'profile-package'])
    expect(result.record.dependencies).toEqual({})
    expect(result.record.bundles).toEqual([])
  })

  it('masks a plaintext credential in the synchronized text and warns', async () => {
    const profilePatch =
      '- id: webdav-sync\n  name: dsh-webdav-sync\n  config:\n    sync:\n      password: hunter2-plain\n'
    const home = track(await createFakeDsh({ profilePatch }))

    const result = await collectDshConfig({ dshHome: home.root, profilesRoot: home.profilesRoot, profile: 'desktop' })

    // The value never enters the record: the key stays, the secret does not.
    const content = result.record.files[1]?.content ?? ''
    expect(content).toContain('password:')
    expect(content).toContain('***')
    expect(content).not.toContain('hunter2-plain')
    expect(content).toContain('dsh-webdav-sync')
    // The digest covers the masked text, so two devices agree on it.
    expect(result.record.files[1]?.sha256).toBe(sha256Text(content))
    const warning = result.record.warnings.find(message => message.includes('已用 *** 标记'))
    expect(warning).toBeDefined()
    expect(JSON.stringify(result.record.warnings)).not.toContain('hunter2-plain')
  })

  it('refuses a profile name that could escape the DSH home', async () => {
    const home = track(await createFakeDsh())
    const result = await collectDshConfig({ dshHome: home.root, profilesRoot: home.profilesRoot, profile: '../evil' })

    expect(result.profileDir).toBeNull()
    expect(result.record.files.map(file => file.kind)).toEqual(['home-patch'])
    expect(result.record.warnings.some(warning => warning.includes('invalid profile name'))).toBe(true)
  })

  it('projects entries through secret rules when the config editor is present', async () => {
    const home = track(
      await createFakeDsh({
        entries: fakeEditorEntries([
          {
            id: 'llm-pi-ai',
            name: '@deepseek-ai/dsh-llm-pi-ai',
            patchId: 'llm-pi-ai',
            config: {
              providers: {
                tflow: {
                  displayName: 'tflow',
                  apiKeyEnv: 'TFLOW_API_KEY',
                  api: 'openai-completions',
                  baseURL: 'https://api.tflow.example/v1',
                  apiKey: 'sk-live-secret-value',
                  models: [{ id: 'model-a', name: 'Model A' }],
                  timeoutMs: 30000,
                },
              },
            },
          },
          {
            id: 'webdav-sync',
            name: 'dsh-webdav-sync',
            config: {
              sync: {
                remoteUrl: 'https://dav.example.com/dsh',
                password: 'hunter2-not-on-the-wire',
                username: 'alice',
              },
              // A raw key pasted into an innocuous-looking field.
              note: 'token sk-embedded-secret-value-12345678',
            },
          },
          { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'tflow', model: 'model-a' } },
        ]),
      }),
    )

    const result = await collectDshConfig({
      dshHome: home.root,
      profilesRoot: home.profilesRoot,
      profile: 'desktop',
      configEditor: home.services.configEditor,
    })

    expect(result.entriesSource).toBe('config-editor')
    const serialized = JSON.stringify(result.record)
    // No secret value of any shape reaches the record.
    for (const secret of ['sk-live-secret-value', 'hunter2-not-on-the-wire', 'sk-embedded-secret-value-12345678']) {
      expect(serialized).not.toContain(secret)
    }
    const llm = result.record.entries.find(entry => entry.id === 'llm-pi-ai')
    const providers = llm?.config['providers'] as Record<string, Record<string, unknown>>
    expect(providers['tflow']?.['apiKeyEnv']).toBe('TFLOW_API_KEY')
    expect(providers['tflow']?.['apiKey']).toBeUndefined()
    expect(providers['tflow']?.['displayName']).toBe('tflow')
    expect(llm?.redacted).toContain('providers.tflow.apiKey')
    const webdav = result.record.entries.find(entry => entry.id === 'webdav-sync')
    expect(webdav?.redacted).toContain('sync.password')
    // The embedded key in a plain string was masked, and the path reported.
    expect(webdav?.config['note']).toBe('***')
    expect(webdav?.redacted).toContain('note')
    // Non-secret values stay.
    const sync = webdav?.config['sync'] as Record<string, unknown>
    expect(sync['username']).toBe('alice')
    expect(sync['remoteUrl']).toBe('https://dav.example.com/dsh')
  })
})

describe('collectProviders', () => {
  /** Build a ConfigEntryRecord literal for the provider normalizer. */
  function entry(id: string, config: JsonObject, name?: string): ConfigEntryRecord {
    const record: ConfigEntryRecord = { id, config, redacted: [] }
    if (name !== undefined) record.name = name
    return record
  }

  it('normalizes providers out of an LLM entry and reads the default model', () => {
    const warnings: string[] = []
    const result = collectProviders(
      [
        entry(
          'llm-pi-ai',
          {
            providers: {
              tflow: {
                displayName: 'TFlow',
                api: 'openai-completions',
                baseURL: 'https://api.tflow.example',
                apiKeyEnv: 'TFLOW_API_KEY',
                models: [{ id: 'a', name: 'A' }, { id: 'b' }],
                timeoutMs: 45000,
                headers: { 'X-Tenant': 'acme' },
              },
            },
          },
          '@deepseek-ai/dsh-llm-pi-ai',
        ),
        entry('agent-default-model', { provider: 'tflow', model: 'a' }, '@deepseek-ai/dsh-agent-default-model'),
      ],
      warnings,
    )

    expect(result.providers).toHaveLength(1)
    const provider = result.providers[0]
    expect(provider?.id).toBe('tflow')
    expect(provider?.entryId).toBe('llm-pi-ai')
    expect(provider?.displayName).toBe('TFlow')
    expect(provider?.api).toBe('openai-completions')
    expect(provider?.baseURL).toBe('https://api.tflow.example')
    expect(provider?.apiKeyEnv).toBe('TFLOW_API_KEY')
    expect(provider?.models).toEqual(['a', 'b'])
    // Header values are credential material by nature, so only other extras
    // survive; the provider keeps no header mapping at all.
    expect(provider?.extra).toEqual({ timeoutMs: 45000 })
    expect(result.defaultModel).toEqual({ provider: 'tflow', model: 'a', entryId: 'agent-default-model' })
    expect(result.warnings).toEqual([])
  })

  it('tolerates a flat provider entry and masks URL credentials', () => {
    const result = collectProviders([
      entry(
        'llm-deepseek',
        {
          id: 'deepseek-official',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'https://user:pass@api.deepseek.com',
          models: ['deepseek-chat'],
        },
        '@deepseek-ai/dsh-llm-deepseek',
      ),
    ])

    const provider = result.providers[0]
    expect(provider?.id).toBe('deepseek-official')
    expect(provider?.models).toEqual(['deepseek-chat'])
    // The credential is inside the URL userinfo, so it is stripped while the
    // endpoint itself survives.
    expect(provider?.baseURL).not.toContain('pass')
    expect(provider?.baseURL).not.toContain('***')
    expect(provider?.baseURL).toMatch(/^https:\/\/api\.deepseek\.com\/?$/)
  })

  it('dedupes by provider id, last declaration wins and names its entry', () => {
    const result = collectProviders([
      entry('layer-a', { providers: { acme: { displayName: 'Old', models: ['m1'] } } }),
      entry('layer-b', { providers: { acme: { displayName: 'New', models: ['m2'] } } }),
    ])
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0]?.displayName).toBe('New')
    expect(result.providers[0]?.models).toEqual(['m2'])
    expect(result.providers[0]?.entryId).toBe('layer-b')
  })
})

describe('createSnapshotCollector', () => {
  it('always returns a valid snapshot and honours section scopes', async () => {
    const home = track(
      await createFakeDsh({
        packageJson: { dependencies: { 'dsh-context': '0.81.2' }, dsh: { profile: { bundles: ['dsh-context'] } } },
        nodeModules: { 'dsh-context': { version: '0.81.2' } },
        entries: fakeEditorEntries([
          {
            id: 'llm-pi-ai',
            name: '@deepseek-ai/dsh-llm-pi-ai',
            config: {
              providers: { tflow: { displayName: 'TFlow', apiKeyEnv: 'TFLOW_API_KEY', models: ['model-a'] } },
            },
          },
          { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'tflow', model: 'model-a' } },
          {
            id: 'mcp-git',
            name: '@deepseek-ai/dsh-mcp-client',
            config: { serverName: 'git', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-server-git@2.0.0'] },
          },
        ]),
      }),
    )

    const logger = createRecordingLogger()
    const collector = createSnapshotCollector({ device: DEVICE, now: () => new Date('2026-01-02T03:04:05.000Z') })
    const context: CollectorContext = {
      dshHome: home.root,
      profilesRoot: home.profilesRoot,
      profile: 'desktop',
      services: home.services,
      logger,
      pluginVersion: '0.1.0',
      dshVersion: '0.2.2-rc.1',
    }
    const scopes: SectionScopes = defaultScopes()

    const snapshot = await collector.collect(context, scopes)

    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.profile).toBe('desktop')
    expect(snapshot.device).toEqual(DEVICE)
    expect(snapshot.generatedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(snapshot.dsh.files.length).toBe(4)
    expect(snapshot.providers.map(provider => provider.id)).toEqual(['tflow'])
    expect(snapshot.defaultModel?.provider).toBe('tflow')
    expect(snapshot.plugins.map(plugin => plugin.id)).toContain('dsh-context')
    expect(snapshot.pluginConfigs).toEqual([])
    expect(snapshot.mcp.map(server => server.id)).toEqual(['mcp:git'])

    // A record carries the *name* of the credential, never a value.
    expect(snapshot.providers[0]?.apiKeyEnv).toBe('TFLOW_API_KEY')
    expect(JSON.stringify(snapshot)).not.toContain('sk-')

    const providersOff = await collector.collect(context, { ...scopes, providers: false })
    expect(providersOff.providers).toEqual([])
    expect(providersOff.defaultModel).toBeNull()

    const everythingOff = await collector.collect(context, {
      dshConfig: false,
      providers: false,
      plugins: false,
      pluginConfigs: false,
      secrets: false,
      mcp: false,
    })
    expect(everythingOff.dsh.files).toEqual([])
    expect(everythingOff.dsh.entries).toEqual([])
    expect(everythingOff.plugins).toEqual([])
    expect(everythingOff.mcp).toEqual([])
  })

  it('survives a missing configuration tree with warnings only', async () => {
    const home = track(await createFakeDsh({ homePatch: null, profilePatch: null, packageJson: null, cordis: null }))
    const logger = createRecordingLogger()
    const collector = createSnapshotCollector({ device: DEVICE, logger })

    const snapshot = await collector.collect(
      {
        dshHome: home.root,
        profilesRoot: home.profilesRoot,
        profile: 'desktop',
        services: {},
        logger,
        pluginVersion: '0.1.0',
        dshVersion: '0.2.2-rc.1',
      },
      defaultScopes(),
    )

    expect(snapshot.dsh.files).toEqual([])
    expect(snapshot.plugins).toEqual([])
    expect(snapshot.providers).toEqual([])
    expect(logger.messages.some(line => line.startsWith('warn:'))).toBe(true)
  })
})
