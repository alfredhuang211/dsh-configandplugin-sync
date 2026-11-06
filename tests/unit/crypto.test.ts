/**
 * Secret envelope encryption.
 *
 * The store may be a public repository, so these tests treat "a key leaked into
 * the document" as the failure that matters: the envelope must never contain a
 * plaintext value, and a wrong passphrase must be a typed, non-destructive
 * error rather than a corrupted state.
 */
import { describe, expect, it } from 'vitest'
import { decryptSecrets, describeEnvelope, encryptSecrets } from '../../src/engine/crypto.js'
import { SyncError } from '../../src/core/errors.js'
import type { SecretsPayload } from '../../src/types.js'

const payload: SecretsPayload = {
  refs: [
    { ref: 'DEEPSEEK_API_KEY', source: 'store' },
    { ref: 'TFLOW_API_KEY', source: 'environment' },
  ],
  values: {
    DEEPSEEK_API_KEY: 'sk-test-0123456789abcdef',
    TFLOW_API_KEY: 'tf-secret-value',
  },
  records: [{ key: 'deepseek-account-platform/default', kind: 'grant', payload: { token: 'grant-token' } }],
}

describe('encryptSecrets / decryptSecrets', () => {
  it('round-trips a payload', async () => {
    const envelope = await encryptSecrets(payload, {
      passphrase: 'correct horse battery staple',
      deviceId: 'dev_1',
    })
    expect(envelope.v).toBe(1)
    expect(envelope.refCount).toBe(2)
    expect(envelope.kdf.name).toBe('scrypt')
    expect(envelope.cipher.name).toBe('aes-256-gcm')

    const restored = await decryptSecrets(envelope, { passphrase: 'correct horse battery staple' })
    expect(restored).toEqual(payload)
  })

  it('never writes a plaintext secret into the envelope', async () => {
    const envelope = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    const serialized = JSON.stringify(envelope)
    expect(serialized).not.toContain('sk-test')
    expect(serialized).not.toContain('tf-secret-value')
    expect(serialized).not.toContain('grant-token')
    // The base64 ciphertext may contain any substring by chance only with
    // negligible probability; check the decoded bytes as well.
    const decoded = Buffer.from(envelope.data, 'base64').toString('latin1')
    expect(decoded).not.toContain('sk-test')
  })

  it('uses a fresh salt and IV per encryption', async () => {
    const first = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    const second = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    expect(first.kdf.salt).not.toBe(second.kdf.salt)
    expect(first.cipher.iv).not.toBe(second.cipher.iv)
    expect(first.data).not.toBe(second.data)
    // Both still decrypt to the same payload.
    expect(await decryptSecrets(second, { passphrase: 'p' })).toEqual(payload)
  })

  it('rejects a wrong passphrase with a typed error', async () => {
    const envelope = await encryptSecrets(payload, { passphrase: 'right', deviceId: 'dev_1' })
    await expect(decryptSecrets(envelope, { passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'passphrase-invalid',
    })
  })

  it('refuses an empty passphrase in both directions', async () => {
    await expect(encryptSecrets(payload, { passphrase: '   ', deviceId: 'dev_1' })).rejects.toBeInstanceOf(SyncError)
    const envelope = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    await expect(decryptSecrets(envelope, { passphrase: '' })).rejects.toMatchObject({ code: 'passphrase-required' })
  })

  it('rejects a tampered ciphertext', async () => {
    const envelope = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    const bytes = Buffer.from(envelope.data, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    const tampered = { ...envelope, data: bytes.toString('base64') }
    await expect(decryptSecrets(tampered, { passphrase: 'p' })).rejects.toMatchObject({ code: 'passphrase-invalid' })
  })

  it('rejects an unsupported envelope version before touching crypto', async () => {
    const envelope = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    await expect(decryptSecrets({ ...envelope, v: 99 }, { passphrase: 'p' })).rejects.toMatchObject({
      code: 'unsupported',
    })
  })

  it('rejects a structurally invalid envelope', async () => {
    await expect(
      decryptSecrets({ v: 1, kdf: { name: 'scrypt', salt: 'x' } } as never, { passphrase: 'p' }),
    ).rejects.toMatchObject({ code: 'invalid-config' })
  })
})

describe('describeEnvelope', () => {
  it('reports presence and metadata without any ciphertext', async () => {
    const envelope = await encryptSecrets(payload, { passphrase: 'p', deviceId: 'dev_1' })
    const info = describeEnvelope(envelope)
    expect(info).toMatchObject({ stored: true, refCount: 2, deviceId: 'dev_1' })
    expect(JSON.stringify(info)).not.toContain(envelope.data)
    expect(describeEnvelope(null)).toEqual({ stored: false })
  })
})
