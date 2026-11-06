/**
 * Section comparison and plan building.
 *
 * This is the safety net for the one thing the product must never do: silently
 * overwrite work from another device. The matrix below is the specification of
 * "who wins" in every local/remote/baseline combination.
 */
import { describe, expect, it } from 'vitest'
import { buildPlan, changedFields, comparisonValue, localItemsFor, mergeItem, remoteItemsFor, tryAutoMerge } from '../../src/engine/sections.js'
import type { AnyRemoteSection, JsonValue, SectionId } from '../../src/types.js'
import { SCHEMA_VERSION } from '../../src/types.js'
import { sha256Json } from '../../src/core/hash.js'
import { makeConfigFile, makeSnapshot } from '../helpers/snapshot.js'

/** Build a remote section document from id → value. */
function remoteSection<T extends JsonValue>(
  section: SectionId,
  items: Record<string, T>,
  deleted: string[] = [],
): AnyRemoteSection {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: 'desktop',
    section,
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    items: Object.fromEntries(
      Object.entries(items).map(([id, value]) => [
        id,
        {
          value,
          ...(deleted.includes(id) ? { deleted: true } : {}),
          updatedAt: new Date(0).toISOString(),
          updatedBy: 'other-device',
        },
      ]),
    ),
  } as unknown as AnyRemoteSection
}

function local(section: SectionId, snapshot: ReturnType<typeof makeSnapshot>, id: string) {
  return localItemsFor(snapshot, section).get(id)
}

function remote(section: SectionId, document: AnyRemoteSection | undefined, id: string) {
  return remoteItemsFor(document, section).get(id)
}

describe('mergeItem', () => {
  const snapshot = makeSnapshot({ providers: [{ id: 'tflow', displayName: 'tflow', models: ['m1'] }] })
  const localItem = local('providers', snapshot, 'tflow')

  it('takes a local-only item when the store has never seen it', () => {
    const merge = mergeItem('providers', localItem, undefined, undefined)
    expect(merge).toMatchObject({ take: 'local', conflict: false })
  })

  it('adopts a remote-only item', () => {
    const remoteDoc = remoteSection('providers', {
      openai: { id: 'openai', entryId: 'llm', models: ['gpt'] },
    })
    const merge = mergeItem('providers', undefined, remote('providers', remoteDoc, 'openai'), undefined)
    expect(merge).toMatchObject({ take: 'remote', conflict: false })
  })

  it('reports identical when both hashes match', () => {
    const value = { id: 'tflow', entryId: 'llm-pi-ai', models: ['m1'] } as unknown as JsonValue
    const remoteDoc = remoteSection('providers', { tflow: value })
    const merge = mergeItem(
      'providers',
      { id: 'tflow', name: 'tflow', value, hash: sha256Json(comparisonValue('providers', value)) },
      remote('providers', remoteDoc, 'tflow'),
      undefined,
    )
    expect(merge.take).toBe('none')
    expect(merge.conflict).toBe(false)
  })

  it('pulls when only the remote changed against a shared baseline', () => {
    const baseValue = comparisonValue('providers', localItem!.value)
    const remoteValue = { ...(baseValue as object), models: ['m2'] } as unknown as JsonValue
    const remoteDoc = remoteSection('providers', { tflow: remoteValue })
    const merge = mergeItem(
      'providers',
      localItem,
      remote('providers', remoteDoc, 'tflow'),
      { hash: sha256Json(baseValue), value: baseValue },
    )
    expect(merge).toMatchObject({ take: 'remote', conflict: false })
  })

  it('conflicts when both changed and no document merge is possible', () => {
    const baseValue = { id: 'tflow', models: ['m1'] } as unknown as JsonValue
    const remoteValue = { id: 'tflow', models: ['m3'] } as unknown as JsonValue
    const remoteDoc = remoteSection('providers', { tflow: remoteValue })
    const merge = mergeItem(
      'providers',
      { ...localItem!, value: { id: 'tflow', models: ['m2'] } as unknown as JsonValue, hash: sha256Json({ id: 'tflow', models: ['m2'] } as unknown as JsonValue) },
      remote('providers', remoteDoc, 'tflow'),
      { hash: sha256Json(baseValue), value: baseValue },
    )
    expect(merge.conflict).toBe(true)
    expect(merge.fields).toContain('models')
  })

  it('conflicts on a first sync when both sides differ', () => {
    const remoteValue = { id: 'tflow', models: ['m9'] } as unknown as JsonValue
    const remoteDoc = remoteSection('providers', { tflow: remoteValue })
    const merge = mergeItem('providers', localItem, remote('providers', remoteDoc, 'tflow'), undefined)
    expect(merge.conflict).toBe(true)
  })

  it('treats a remote tombstone as nothing to do without a baseline', () => {
    const remoteDoc = remoteSection('providers', { tflow: { id: 'tflow' } as unknown as JsonValue }, ['tflow'])
    const merge = mergeItem('providers', localItem, remote('providers', remoteDoc, 'tflow'), undefined)
    expect(merge.take).toBe('none')
    expect(merge.conflict).toBe(false)
  })
})

describe('tryAutoMerge (patch documents)', () => {
  it('merges two devices that edited different entries', () => {
    const base = makeConfigFile({
      path: 'profiles/desktop/cordis.patch.yml',
      content: '- id: a\n  name: pkg-a\n  config:\n    v: 1\n- id: b\n  name: pkg-b\n  config:\n    v: 1\n',
    })
    const localFile = makeConfigFile({
      path: base.path,
      content: '- id: a\n  name: pkg-a\n  config:\n    v: 2\n- id: b\n  name: pkg-b\n  config:\n    v: 1\n',
    })
    const remoteFile = makeConfigFile({
      path: base.path,
      content: '- id: a\n  name: pkg-a\n  config:\n    v: 1\n- id: b\n  name: pkg-b\n  config:\n    v: 3\n',
    })
    const merged = tryAutoMerge(
      'dsh-config',
      localFile as unknown as JsonValue,
      remoteFile as unknown as JsonValue,
      base as unknown as JsonValue,
    ) as unknown as { content: string }
    expect(merged).not.toBeNull()
    expect(merged.content).toContain('v: 2')
    expect(merged.content).toContain('v: 3')
  })

  it('refuses to merge when both edited the same entry', () => {
    const base = makeConfigFile({ path: 'p/cordis.patch.yml', content: '- id: a\n  config:\n    v: 1\n' })
    const localFile = makeConfigFile({ path: base.path, content: '- id: a\n  config:\n    v: 2\n' })
    const remoteFile = makeConfigFile({ path: base.path, content: '- id: a\n  config:\n    v: 3\n' })
    expect(
      tryAutoMerge(
        'dsh-config',
        localFile as unknown as JsonValue,
        remoteFile as unknown as JsonValue,
        base as unknown as JsonValue,
      ),
    ).toBeNull()
  })

  it('merges disjoint package.json dependency changes', () => {
    const base = makeConfigFile({
      path: 'profiles/desktop/package.json',
      kind: 'profile-package',
      content: JSON.stringify({ dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['a'] } } }),
    })
    const localFile = makeConfigFile({
      path: base.path,
      kind: 'profile-package',
      content: JSON.stringify({ dependencies: { a: '1.0.0', b: '2.0.0' }, dsh: { profile: { bundles: ['a', 'b'] } } }),
    })
    const remoteFile = makeConfigFile({
      path: base.path,
      kind: 'profile-package',
      content: JSON.stringify({ dependencies: { a: '1.1.0' }, dsh: { profile: { bundles: ['a'] } } }),
    })
    const merged = tryAutoMerge(
      'dsh-config',
      localFile as unknown as JsonValue,
      remoteFile as unknown as JsonValue,
      base as unknown as JsonValue,
    ) as unknown as { content: string }
    const parsed = JSON.parse(merged.content) as { dependencies: Record<string, string> }
    expect(parsed.dependencies.a).toBe('1.1.0')
    expect(parsed.dependencies.b).toBe('2.0.0')
  })
})

describe('changedFields', () => {
  it('lists nested fields that differ', () => {
    expect(changedFields({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual(['b.c'])
  })
})

describe('buildPlan', () => {
  const snapshot = makeSnapshot({
    plugins: [
      { id: 'pkg-a', name: 'pkg-a', version: '1.0.0' },
      { id: 'pkg-local', name: 'pkg-local', version: null, origin: 'local-path', installSpec: null, restorable: false },
    ],
    providers: [{ id: 'tflow', displayName: 'tflow', models: ['m1'] }],
    mcp: [{ serverName: 'github', command: 'npx' }],
  })

  const enabled = {
    'dsh-config': true,
    providers: true,
    plugins: true,
    'plugin-configs': true,
    secrets: false,
    mcp: true,
  }
  const excluded = { 'dsh-config': [], providers: [], plugins: [], 'plugin-configs': [], secrets: [], mcp: [] }

  it('plans a push for every local item on a first backup', () => {
    const plan = buildPlan({
      direction: 'push',
      profile: 'desktop',
      snapshot,
      remote: new Map(),
      baseline: {},
      enabled,
      excluded,
      resolutions: [],
    })
    const kinds = plan.actions.map(action => action.kind)
    expect(kinds).toContain('push-plugin')
    expect(kinds).toContain('push-provider')
    expect(kinds).toContain('push-mcp')
    expect(kinds).toContain('push-dsh-config')
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.requiresConfirmation).toBe(false)
  })

  it('plans a pull that installs remote plugins', () => {
    const remoteDoc = remoteSection('plugins', {
      'pkg-b': {
        id: 'pkg-b',
        name: 'pkg-b',
        version: '2.0.0',
        origin: 'npm',
        installSpec: 'pkg-b@2.0.0',
        enabled: true,
        builtIn: false,
        syncable: true,
        restorable: true,
        profile: 'desktop',
        platform: 'linux',
        rows: [],
      } as unknown as JsonValue,
    })
    const plan = buildPlan({
      direction: 'pull',
      profile: 'desktop',
      snapshot,
      remote: new Map([['plugins', remoteDoc]]),
      baseline: {},
      enabled,
      excluded,
      resolutions: [],
    })
    const install = plan.actions.find(action => action.kind === 'install-plugin')
    expect(install).toBeDefined()
    expect(install?.installSpec).toBe('pkg-b@2.0.0')
    expect(install?.value).toBeDefined()
  })

  it('keeps a destructive removal out of the actions until it is confirmed', () => {
    // Local plugin was removed since the baseline; the store still has it.
    const baseValue = {
      id: 'pkg-gone',
      name: 'pkg-gone',
      version: '1.0.0',
      origin: 'npm',
      installSpec: 'pkg-gone@1.0.0',
      enabled: true,
      builtIn: false,
      syncable: true,
      restorable: true,
      profile: 'desktop',
      platform: 'darwin',
      rows: [],
    } as unknown as JsonValue
    const remoteDoc = remoteSection('plugins', { 'pkg-gone': baseValue })
    const plan = buildPlan({
      direction: 'push',
      profile: 'desktop',
      snapshot,
      remote: new Map([['plugins', remoteDoc]]),
      baseline: { plugins: { 'pkg-gone': { hash: sha256Json(baseValue), value: baseValue } } },
      enabled,
      excluded,
      resolutions: [],
    })
    const removal = plan.actions.find(action => action.kind === 'remove-remote-item')
    expect(removal?.destructive).toBe(true)
    expect(plan.requiresConfirmation).toBe(true)
  })

  it('applies a conflict resolution for the local side', () => {
    const remoteDoc = remoteSection('providers', {
      tflow: { id: 'tflow', entryId: 'llm', models: ['m9'] } as unknown as JsonValue,
    })
    const unresolved = buildPlan({
      direction: 'two-way',
      profile: 'desktop',
      snapshot,
      remote: new Map([['providers', remoteDoc]]),
      baseline: {},
      enabled,
      excluded,
      resolutions: [],
    })
    expect(unresolved.conflicts).toHaveLength(1)

    const resolved = buildPlan({
      direction: 'two-way',
      profile: 'desktop',
      snapshot,
      remote: new Map([['providers', remoteDoc]]),
      baseline: {},
      enabled,
      excluded,
      resolutions: [{ section: 'providers', id: 'tflow', choice: 'local' }],
    })
    expect(resolved.conflicts).toHaveLength(0)
    expect(resolved.actions.some(action => action.kind === 'push-provider')).toBe(true)
  })

  it('skips a section that is switched off', () => {
    const plan = buildPlan({
      direction: 'push',
      profile: 'desktop',
      snapshot,
      remote: new Map(),
      baseline: {},
      enabled: { ...enabled, mcp: false },
      excluded,
      resolutions: [],
    })
    expect(plan.actions.some(action => action.section === 'mcp')).toBe(false)
  })

  it('honors the exclusion list', () => {
    const plan = buildPlan({
      direction: 'push',
      profile: 'desktop',
      snapshot,
      remote: new Map(),
      baseline: {},
      enabled,
      excluded: { ...excluded, plugins: ['pkg-a'] },
      resolutions: [],
    })
    expect(plan.actions.some(action => action.id === 'pkg-a')).toBe(false)
  })

  it('pushes an encrypted secret envelope only when one is supplied', () => {
    const envelope = {
      v: 1,
      kdf: { name: 'scrypt' as const, N: 1, r: 1, p: 1, salt: 's' },
      cipher: { name: 'aes-256-gcm' as const, iv: 'i', tag: 't' },
      data: 'd',
      createdAt: new Date(0).toISOString(),
      deviceId: 'dev',
      refCount: 1,
    }
    const plan = buildPlan({
      direction: 'push',
      profile: 'desktop',
      snapshot,
      remote: new Map(),
      baseline: {},
      enabled: { ...enabled, secrets: true },
      excluded,
      resolutions: [],
      secretsEnvelope: envelope,
    })
    expect(plan.actions.some(action => action.kind === 'push-secret')).toBe(true)
  })
})
