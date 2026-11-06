/**
 * The store layout and its compare-and-set write path.
 *
 * The failure these tests guard against is a lost write: two devices pushing
 * different sections at the same time must either merge or conflict, never
 * silently drop one side.
 */
import { describe, expect, it } from 'vitest'
import { createRepository, parseContents, sectionPath } from '../../src/engine/repository.js'
import type { AnyRemoteSection, RemoteSection, SectionId } from '../../src/types.js'
import { SCHEMA_VERSION } from '../../src/types.js'
import { createNullLogger } from '../../src/core/logger.js'
import { createMemoryBackend } from '../helpers/memory-backend.js'

const logger = createNullLogger()

function section<T>(profile: string, id: SectionId, items: Record<string, unknown>): AnyRemoteSection {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile,
    section: id,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    items: Object.fromEntries(
      Object.entries(items).map(([key, value]) => [
        key,
        { value, updatedAt: new Date(0).toISOString(), updatedBy: 'test' },
      ]),
    ),
  } as AnyRemoteSection
}

function repository(backend: ReturnType<typeof createMemoryBackend>) {
  return createRepository({
    backend,
    logger,
    generator: { name: 'dsh-configandplugin-sync', version: '0.1.0' },
  })
}

describe('repository write/read', () => {
  it('writes a section document and a manifest, then reads it back', async () => {
    const backend = createMemoryBackend()
    const repo = repository(backend)
    const result = await repo.write({
      profile: 'desktop',
      sections: {
        plugins: section('desktop', 'plugins', {
          'pkg-a': { id: 'pkg-a', name: 'pkg-a', version: '1.0.0' },
        }),
      },
      message: 'backup',
      trailers: { operation: 'backup', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
    })
    expect(result.changed).toBe(true)
    const files = backend.snapshot()
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'profiles/desktop/plugins.json'].sort())

    const contents = await repo.read()
    const plugins = contents.profiles.get('desktop')?.get('plugins')
    expect(plugins?.revision).toBe(1)
    expect(Object.keys(plugins?.items ?? {})).toEqual(['pkg-a'])
    expect(contents.manifest?.revision).toBe(1)
    expect(contents.manifest?.devices).toEqual([])
    expect(contents.manifest?.digests['profiles/desktop/plugins.json']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('increments the document revision on each write', async () => {
    const backend = createMemoryBackend()
    const repo = repository(backend)
    const write = async (version: string): Promise<void> => {
      await repo.write({
        profile: 'desktop',
        sections: { providers: section('desktop', 'providers', { tflow: { id: 'tflow', version } }) },
        message: 'update',
        trailers: { operation: 'sync', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
      })
    }
    await write('1')
    await write('2')
    const contents = await repo.read()
    const providers = contents.profiles.get('desktop')?.get('providers') as RemoteSection<{ version: string }>
    expect(providers.revision).toBe(2)
    expect(providers.items.tflow?.value.version).toBe('2')
    expect(contents.manifest?.revision).toBe(2)
  })

  it('preserves a section the change did not name', async () => {
    const backend = createMemoryBackend()
    const repo = repository(backend)
    await repo.write({
      profile: 'desktop',
      sections: { mcp: section('desktop', 'mcp', { 'mcp:x': { id: 'mcp:x' } }) },
      message: 'mcp',
      trailers: { operation: 'sync', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
    })
    await repo.write({
      profile: 'desktop',
      sections: { plugins: section('desktop', 'plugins', { 'pkg-a': { id: 'pkg-a' } }) },
      message: 'plugins',
      trailers: { operation: 'sync', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
    })
    const contents = await repo.read()
    expect(contents.profiles.get('desktop')?.get('mcp')).toBeDefined()
    expect(contents.profiles.get('desktop')?.get('plugins')).toBeDefined()
  })

  it('retries a concurrent write through the rebuild callback instead of clobbering it', async () => {
    const backend = createMemoryBackend()
    const repo = repository(backend)
    await repo.write({
      profile: 'desktop',
      sections: { plugins: section('desktop', 'plugins', { 'pkg-a': { id: 'pkg-a' } }) },
      message: 'seed',
      trailers: { operation: 'sync', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
    })

    // The backend rejects the next write as a conflict, exactly as a real
    // object-store CAS or a moved git HEAD would.
    backend.failNextWriteWithConflict()
    let rebuildCalls = 0
    const result = await repo.write({
      profile: 'desktop',
      sections: { providers: section('desktop', 'providers', { tflow: { id: 'tflow' } }) },
      message: 'providers',
      trailers: { operation: 'sync', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
      rebuild: async fresh => {
        rebuildCalls += 1
        const plugins = fresh.profiles.get('desktop')?.get('plugins')
        return {
          profile: 'desktop',
          sections: {
            plugins: section('desktop', 'plugins', plugins?.items ?? {}),
            providers: section('desktop', 'providers', { tflow: { id: 'tflow' } }),
          },
          message: 'providers',
          trailers: { operation: 'sync', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '2' },
        }
      },
    })
    expect(rebuildCalls).toBe(1)
    expect(result.retried).toBe(true)
    expect(result.changed).toBe(true)
    const contents = await repo.read()
    const plugins = contents.profiles.get('desktop')?.get('plugins')
    // The concurrent device's plugin document was re-applied, not dropped.
    expect(Object.keys(plugins?.items ?? {})).toEqual(['pkg-a'])
    expect(contents.profiles.get('desktop')?.get('providers')).toBeDefined()
  })

  it('surfaces a persistent conflict when no rebuild is supplied', async () => {
    const backend = createMemoryBackend()
    const repo = repository(backend)
    backend.failNextWriteWithConflict()
    await expect(
      repo.write({
        profile: 'desktop',
        sections: { plugins: section('desktop', 'plugins', { 'pkg-a': { id: 'pkg-a' } }) },
        message: 'backup',
        trailers: { operation: 'backup', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('writes a device snapshot when one is supplied', async () => {
    const backend = createMemoryBackend()
    const repo = repository(backend)
    await repo.write({
      profile: 'desktop',
      sections: { plugins: section('desktop', 'plugins', { 'pkg-a': { id: 'pkg-a' } }) },
      device: {
        schemaVersion: SCHEMA_VERSION,
        device: {
          id: 'dev_1',
          name: 'laptop',
          platform: 'darwin',
          arch: 'arm64',
          dshVersion: '0.2.2',
          pluginVersion: '0.1.0',
        },
        profiles: {},
        updatedAt: new Date(0).toISOString(),
      },
      message: 'backup',
      trailers: { operation: 'backup', deviceId: 'dev_1', deviceName: 'laptop', profile: 'desktop', result: 'ok', itemCount: '1' },
    })
    const contents = await repo.read()
    expect(contents.devices.get('dev_1')?.device.name).toBe('laptop')
    expect(contents.manifest?.devices).toEqual(['dev_1'])
  })
})

describe('parseContents', () => {
  it('ignores a corrupt document instead of failing the whole read', async () => {
    const backend = createMemoryBackend({
      files: {
        'profiles/desktop/plugins.json': '{ not json',
        'manifest.json': JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          generator: { name: 'x', version: '1' },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          revision: 3,
          devices: [],
          profiles: {},
          digests: {},
        }),
      },
    })
    const snapshot = await backend.read()
    const contents = parseContents(snapshot, logger)
    expect(contents.manifest?.revision).toBe(3)
    expect(contents.profiles.size).toBe(0)
  })

  it('refuses an invalid profile name', () => {
    expect(() => sectionPath('../escape', 'plugins')).toThrow()
    expect(sectionPath('desktop', 'plugins')).toBe('profiles/desktop/plugins.json')
  })
})
