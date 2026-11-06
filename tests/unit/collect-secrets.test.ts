/**
 * Collector tests: the secret slice.
 *
 * These tests care about two things in equal measure: that the parsed payload
 * round-trips, and that no secret value leaks into a warning, a log line, an
 * error message or a record that is not the payload itself.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { stat } from 'node:fs/promises'
import { createFakeDsh, createRecordingLogger, type FakeDsh } from '../integration/fake-dsh.js'
import {
  MinimalYamlError,
  parseCredentialsDocument,
  parseMinimalYaml,
  readSecrets,
  writeSecrets,
} from '../../src/collect/secrets.js'
import { SyncError } from '../../src/core/errors.js'
import type { SecretsPayload } from '../../src/types.js'

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

const SECRETS = {
  deepseek: 'sk-deepseek-secret-AAAAAAAA1111',
  tflow: 'sk-tflow-secret-BBBBBBBB2222',
  grant: 'rk-grant-secret-CCCCCCCC3333',
}

/** A credentials document in the version-1 layout DSH writes. */
function credentialsText(): string {
  return [
    'version: 1',
    'refs:',
    `  DEEPSEEK_API_KEY: ${SECRETS.deepseek}`,
    `  TFLOW_API_KEY: '${SECRETS.tflow}'`,
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${SECRETS.grant}`,
    '  deepseek-account-platform/device:',
    '    kind: grant',
    '    payload:',
    '      id: device-uuid-4444',
    '',
  ].join('\n')
}

/** The values a payload carries; used only for assertions. */
function payloadValues(payload: SecretsPayload): Record<string, string> {
  return payload.values
}

describe('minimal YAML reader', () => {
  it('parses block mappings, quoted strings, comments and scalars', () => {
    const parsed = parseMinimalYaml(
      ['# comment', 'version: 1', "name: 'it''s'", 'quoted: "a: b # not a comment"', 'flag: true', 'empty: null', ''].join(
        '\n',
      ),
    )
    expect(parsed).toEqual({
      version: 1,
      name: "it's",
      quoted: 'a: b # not a comment',
      flag: true,
      empty: null,
    })
  })

  it('parses nested mappings and block sequences', () => {
    const parsed = parseMinimalYaml(['root:', '  child:', '    - one', '    - two', '  other: {}', ''].join('\n'))
    expect(parsed).toEqual({ root: { child: ['one', 'two'], other: {} } })
  })

  it('rejects a malformed document with a line number and no content', () => {
    let error: unknown
    try {
      parseMinimalYaml(['version: 1', 'refs:', '  A: "unterminated-secret-value', ''].join('\n'))
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(MinimalYamlError)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain('line 3')
    expect(message).not.toContain('unterminated-secret-value')
  })
})

describe('parseCredentialsDocument', () => {
  it('reads refs and tagged records', () => {
    const document = parseCredentialsDocument(credentialsText())
    expect(document.version).toBe(1)
    expect(document.refs.get('DEEPSEEK_API_KEY')).toBe(SECRETS.deepseek)
    expect(document.refs.get('TFLOW_API_KEY')).toBe(SECRETS.tflow)
    const grant = document.records.get('client-connection/browser-session')
    expect(grant?.kind).toBe('grant')
    expect(grant?.payload).toEqual({ version: 1, secret: SECRETS.grant })
    expect(document.legacyFlat).toBe(false)
  })

  it('migrates the pre-release flat layout on read', () => {
    const document = parseCredentialsDocument('LEGACY_KEY: legacy-secret-value\nOTHER: second\n')
    expect(document.legacyFlat).toBe(true)
    expect(document.refs.get('LEGACY_KEY')).toBe('legacy-secret-value')
    expect(document.version).toBe(1)
  })
})

describe('readSecrets', () => {
  it('reads the store without leaking a value into logs or warnings', async () => {
    const home = track(await createFakeDsh({ credentials: credentialsText() }))
    const logger = createRecordingLogger()

    const result = await readSecrets({ dshHome: home.root, logger })

    expect(result.payload.refs.map(ref => ref.ref)).toEqual(['DEEPSEEK_API_KEY', 'TFLOW_API_KEY'])
    expect(result.payload.refs.every(ref => ref.source === 'store')).toBe(true)
    expect(payloadValues(result.payload)).toEqual({
      DEEPSEEK_API_KEY: SECRETS.deepseek,
      TFLOW_API_KEY: SECRETS.tflow,
    })
    expect(result.payload.records.map(record => record.key)).toEqual([
      'client-connection/browser-session',
      'deepseek-account-platform/device',
    ])
    expect(result.payload.records[0]?.payload).toEqual({ version: 1, secret: SECRETS.grant })

    // Reference records and warnings never carry a value.
    const nonPayload = JSON.stringify({ refs: result.payload.refs, warnings: result.warnings })
    for (const value of Object.values(SECRETS)) {
      expect(nonPayload).not.toContain(value)
    }
    const logged = [...logger.messages, ...logger.payloads].join('\n')
    for (const value of Object.values(SECRETS)) {
      expect(logged).not.toContain(value)
    }
  })

  it('discovers environment-only references without reading their value', async () => {
    const home = track(await createFakeDsh({ credentials: credentialsText() }))
    const result = await readSecrets({
      dshHome: home.root,
      candidateRefs: ['ENV_ONLY_KEY', 'DEEPSEEK_API_KEY'],
      env: { ENV_ONLY_KEY: 'env-secret-value-never-must-leak' },
    })

    const envRef = result.payload.refs.find(ref => ref.ref === 'ENV_ONLY_KEY')
    expect(envRef?.source).toBe('environment')
    expect(result.payload.values['ENV_ONLY_KEY']).toBeUndefined()
    // The store value wins for a reference that exists in both layers.
    expect(result.payload.values['DEEPSEEK_API_KEY']).toBe(SECRETS.deepseek)
    expect(JSON.stringify(result.payload.refs)).not.toContain('env-secret-value-never-must-leak')
  })

  it('prefers the credential seam for values and records', async () => {
    const home = track(await createFakeDsh())
    const seen: string[] = []
    const credentials = {
      describe: async (ref: string) => {
        seen.push(`describe:${ref}`)
        if (ref === 'FROM_STORE') return { configured: true, source: 'store', writable: true }
        if (ref === 'FROM_ENV') return { configured: true, source: 'environment', writable: false }
        return { configured: false, writable: false }
      },
      resolve: async (ref: string) => {
        seen.push(`resolve:${ref}`)
        if (ref === 'FROM_STORE') return { value: 'store-secret-value', source: 'store' }
        if (ref === 'FROM_ENV') return { value: 'env-secret-value', source: 'environment' }
        return undefined
      },
      listRecords: async () => [{ key: 'svc/grant', kind: 'grant' as const }],
      readRecord: async (key: string) =>
        key === 'svc/grant' ? { kind: 'grant' as const, payload: { token: 'record-secret-value' } } : undefined,
    }

    const result = await readSecrets({
      dshHome: home.root,
      credentials,
      candidateRefs: ['FROM_STORE', 'FROM_ENV', 'MISSING'],
      env: {},
    })

    expect(result.payload.values['FROM_STORE']).toBe('store-secret-value')
    expect(result.payload.values['FROM_ENV']).toBeUndefined()
    expect(result.payload.refs.find(ref => ref.ref === 'FROM_ENV')?.source).toBe('environment')
    expect(result.payload.values['MISSING']).toBeUndefined()
    expect(result.payload.records).toEqual([{ key: 'svc/grant', kind: 'grant', payload: { token: 'record-secret-value' } }])
    expect(seen).toContain('describe:FROM_STORE')
    const serialized = JSON.stringify({ refs: result.payload.refs, warnings: result.warnings })
    expect(serialized).not.toContain('store-secret-value')
    expect(serialized).not.toContain('env-secret-value')
    expect(serialized).not.toContain('record-secret-value')
  })

  it('rejects an unreadable document with a line number only', async () => {
    const home = track(await createFakeDsh({ credentials: 'version: 1\nrefs:\n  A: "unterminated-secret\n' }))
    let error: unknown
    try {
      await readSecrets({ dshHome: home.root })
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(SyncError)
    expect((error as SyncError).code).toBe('invalid-config')
    expect((error as Error).message).not.toContain('unterminated-secret')
  })
})

describe('writeSecrets', () => {
  const payload: SecretsPayload = {
    refs: [
      { ref: 'NEW_REF', source: 'store' },
      { ref: 'ENV_ONLY', source: 'environment' },
    ],
    values: { NEW_REF: 'new-secret-value-9999' },
    records: [{ key: 'svc/token', kind: 'grant', payload: { token: 'grant-secret-payload' } }],
  }

  it('writes a private document atomically and preserves unrelated keys', async () => {
    const home = track(await createFakeDsh())
    const path = home.path('.credentials.yaml')
    await home.write(
      '.credentials.yaml',
      ['version: 1', 'refs:', '  KEEP_ME: keep-this-value', 'records: {}', 'future: 1', ''].join('\n'),
    )

    const result = await writeSecrets(payload, { credentialsPath: path })

    expect(result.updatedRefs).toEqual(['NEW_REF'])
    expect(result.updatedRecords).toEqual(['svc/token'])
    expect(result.skipped).toContain('ENV_ONLY')
    // No warning, list or payload carries a value.
    expect(JSON.stringify(result)).not.toContain('new-secret-value-9999')
    expect(JSON.stringify(result)).not.toContain('grant-secret-payload')

    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)

    const reread = await readSecrets({ dshHome: home.root })
    expect(reread.payload.values['KEEP_ME']).toBe('keep-this-value')
    expect(reread.payload.values['NEW_REF']).toBe('new-secret-value-9999')
    expect(reread.payload.records[0]).toEqual({
      key: 'svc/token',
      kind: 'grant',
      payload: { token: 'grant-secret-payload' },
    })
    const text = (await home.read('.credentials.yaml')) ?? ''
    expect(text.startsWith('version: 1\n')).toBe(true)
    expect(text).toContain('future: 1')
  })

  it('creates a missing document at mode 0600', async () => {
    const home = track(await createFakeDsh())
    const path = home.path('.credentials.yaml')
    await writeSecrets(payload, { credentialsPath: path })
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    const reread = await readSecrets({ dshHome: home.root })
    // An environment-only reference has no stored value, so nothing is written.
    expect(reread.payload.refs.map(ref => ref.ref)).toEqual(['NEW_REF'])
    expect(reread.payload.refs[0]?.source).toBe('store')
  })

  it('uses the credential seam when it is mounted', async () => {
    const home = track(await createFakeDsh())
    const setCalls: Array<[string, string]> = []
    const recordCalls: string[] = []
    const credentials = {
      set: async (ref: string, value: string) => {
        setCalls.push([ref, value])
      },
      modifyRecord: async (key: string) => {
        recordCalls.push(key)
        return undefined
      },
    }

    const result = await writeSecrets(payload, { credentials, credentialsPath: home.path('.credentials.yaml') })

    expect(setCalls.map(call => call[0])).toEqual(['NEW_REF'])
    expect(recordCalls).toEqual(['svc/token'])
    expect(result.updatedRefs).toEqual(['NEW_REF'])
    expect(result.updatedRecords).toEqual(['svc/token'])
    expect(result.skipped).toContain('ENV_ONLY')
    // The value reached the seam, never a log line.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('new-secret-value-9999')
  })

  it('refuses to rewrite a document it cannot parse', async () => {
    const home = track(await createFakeDsh())
    const path = home.path('.credentials.yaml')
    await home.write('.credentials.yaml', 'version: 1\nrefs:\n  A: "unterminated-secret\n')
    const before = await home.read('.credentials.yaml')

    let error: unknown
    try {
      await writeSecrets(payload, { credentialsPath: path })
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(SyncError)
    expect((error as SyncError).code).toBe('invalid-config')
    expect(await home.read('.credentials.yaml')).toBe(before)
  })
})
