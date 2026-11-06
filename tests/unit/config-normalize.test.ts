/**
 * Configuration normalization.
 *
 * The passphrase field names an environment variable. A passphrase pasted into
 * it must never be persisted: that would store a secret in the configuration
 * file and could never resolve, so it is a silently broken setup either way.
 */
import { describe, expect, it } from 'vitest'
import { defaultConfig, normalizeConfig, normalizeEnvName } from '../../src/state/store.js'

describe('normalizeEnvName', () => {
  it('keeps a valid POSIX identifier', () => {
    expect(normalizeEnvName('DSH_SYNC_PASSPHRASE', 'FALLBACK')).toBe('DSH_SYNC_PASSPHRASE')
    expect(normalizeEnvName('  _MY_KEY_2 ', 'FALLBACK')).toBe('_MY_KEY_2')
  })

  it('rejects values that cannot be a shell variable name', () => {
    expect(normalizeEnvName('my passphrase', 'FALLBACK')).toBe('FALLBACK')
    expect(normalizeEnvName('sk-abc123', 'FALLBACK')).toBe('FALLBACK')
    expect(normalizeEnvName('"quoted"', 'FALLBACK')).toBe('FALLBACK')
    expect(normalizeEnvName('', 'FALLBACK')).toBe('FALLBACK')
    expect(normalizeEnvName(42, 'FALLBACK')).toBe('FALLBACK')
  })

  it('cannot tell an identifier-shaped secret from a name', () => {
    // Documented limit: this is why the page labels the field and the status
    // warns when the named variable is not set.
    expect(normalizeEnvName('alfred130211', 'FALLBACK')).toBe('alfred130211')
  })
})

describe('normalizeConfig', () => {
  it('drops a value that is not a variable name', () => {
    const config = normalizeConfig({ passphraseEnvVar: 'not a var name' }, 'desktop', ['desktop'])
    expect(config.passphraseEnvVar).toBe(defaultConfig('desktop', ['desktop']).passphraseEnvVar)
  })

  it('keeps an explicitly configured variable name', () => {
    const config = normalizeConfig({ passphraseEnvVar: 'MY_SYNC_PASSPHRASE' }, 'desktop', ['desktop'])
    expect(config.passphraseEnvVar).toBe('MY_SYNC_PASSPHRASE')
  })
})
