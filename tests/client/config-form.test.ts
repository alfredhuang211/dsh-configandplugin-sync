/**
 * Tests for the configuration form rules: secret masking, write-only secrets,
 * backend switching without data loss, profile invariants, and auto-sync
 * sanitization.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_DELAY_MS,
  MAX_INTERVAL_MINUTES,
  buildSyncConfig,
  createConfigForm,
  hasTypedSecret,
  msToSeconds,
  patchAutoSync,
  patchGit,
  patchS3,
  patchWebdav,
  sanitizeAutoSync,
  secondsToMs,
  setBackendKind,
  setDeviceName,
  setPassphraseEnvVar,
  setScope,
  toggleProfile,
} from '../../client/src/config-form'
import type { ConfigForm } from '../../client/src/config-form'
import { makeConfigView } from './fixtures'

/** A view whose secret fields are populated, as an unfixed Host would send them. */
function viewWithSecrets() {
  const view = makeConfigView()
  return makeConfigView({
    backendKind: 'webdav',
    webdav: { ...view.webdav, password: 'stored-password', token: 'stored-token' },
    s3: { ...view.s3, secretAccessKey: 'stored-secret', sessionToken: 'stored-session' },
    git: { ...view.git, tokenEnvVar: 'GITHUB_TOKEN' },
  })
}

describe('createConfigForm', () => {
  it('never copies a secret into renderable form state', () => {
    const form = createConfigForm(viewWithSecrets())
    expect(form.webdav.password).toBe('')
    expect(form.webdav.token).toBe('')
    expect(form.s3.secretAccessKey).toBe('')
    expect(form.s3.sessionToken).toBe('')
  })

  it('copies every non-secret field', () => {
    const view = viewWithSecrets()
    const form = createConfigForm(view)
    expect(form.backendKind).toBe('webdav')
    expect(form.webdav.url).toBe(view.webdav.url)
    expect(form.webdav.username).toBe(view.webdav.username)
    expect(form.git.repoUrl).toBe(view.git.repoUrl)
    expect(form.git.authMode).toBe('ssh')
    expect(form.git.tokenEnvVar).toBe('GITHUB_TOKEN')
    expect(form.s3.accessKeyId).toBe('AKIAEXAMPLE')
    expect(form.s3.forcePathStyle).toBe(true)
    expect(form.profiles).toEqual(['default', 'work'])
    expect(form.scopes.secrets).toBe(false)
    expect(form.passphraseEnvVar).toBe('DSH_SYNC_PASSPHRASE')
    expect(form.deviceName).toBe('laptop')
    expect(form.autoSync.startupDelayMs).toBe(15_000)
  })

  it('falls back to the active profile when the view lists none', () => {
    const form = createConfigForm(makeConfigView({ profiles: [], availableProfiles: ['default'] }))
    expect(form.profiles).toEqual(['default'])
  })

  it('deep-copies the mutable collections', () => {
    const view = viewWithScopes()
    const form = createConfigForm(view)
    form.profiles.push('extra')
    form.excluded.plugins?.push('mutated')
    expect(view.profiles).not.toContain('extra')
    expect(view.excluded.plugins).toEqual(['local:notes'])
  })
})

/** A view with a scoped exclusion list, for the copy test. */
function viewWithScopes() {
  return makeConfigView()
}

describe('field patches', () => {
  const base = createConfigForm(viewWithSecrets())

  it('patches one backend without touching the others', () => {
    const next = patchGit(base, { branch: 'dev' })
    expect(next.git.branch).toBe('dev')
    expect(next.webdav).toBe(base.webdav)
    expect(next.s3).toBe(base.s3)
    expect(base.git.branch).toBe('main')
  })

  it('patches WebDAV and S3 fields', () => {
    expect(patchWebdav(base, { url: 'https://dav.example.com/other' }).webdav.url).toBe(
      'https://dav.example.com/other',
    )
    expect(patchS3(base, { bucket: 'other' }).s3.bucket).toBe('other')
  })

  it('patches the automatic-sync block', () => {
    const next = patchAutoSync(base, { enabled: true, intervalMinutes: 30 })
    expect(next.autoSync.enabled).toBe(true)
    expect(next.autoSync.intervalMinutes).toBe(30)
    expect(base.autoSync.enabled).toBe(false)
  })

  it('keeps all three backend blocks when the active backend changes', () => {
    const next = setBackendKind(base, 's3')
    expect(next.backendKind).toBe('s3')
    expect(next.git.repoUrl).toBe(base.git.repoUrl)
    expect(next.webdav.url).toBe(base.webdav.url)
    expect(next.s3.endpoint).toBe(base.s3.endpoint)
  })

  it('sets device name, passphrase variable, and one scope', () => {
    expect(setDeviceName(base, 'desk').deviceName).toBe('desk')
    expect(setPassphraseEnvVar(base, 'OTHER_PASS').passphraseEnvVar).toBe('OTHER_PASS')
    const next = setScope(base, 'secrets', true)
    expect(next.scopes.secrets).toBe(true)
    expect(next.scopes.plugins).toBe(true)
    expect(base.scopes.secrets).toBe(false)
  })
})

describe('profiles', () => {
  const form = createConfigForm(makeConfigView())

  it('never removes the active profile', () => {
    expect(toggleProfile(form, 'default', 'default')).toBe(form)
    expect(toggleProfile(form, 'default', 'default').profiles).toContain('default')
  })

  it('adds and removes other profiles', () => {
    const removed = toggleProfile(form, 'work', 'default')
    expect(removed.profiles).toEqual(['default'])
    const added = toggleProfile(removed, 'work', 'default')
    expect(added.profiles).toEqual(['default', 'work'])
  })

  it('always keeps the active profile in a non-empty list', () => {
    const start: ConfigForm = { ...form, profiles: [] }
    const next = toggleProfile(start, 'work', 'default').profiles
    expect(next).toContain('default')
    expect(next).not.toHaveLength(0)
    expect(next.length).toBeLessThanOrEqual(2)
  })
})

describe('buildSyncConfig', () => {
  const base = viewWithSecrets()

  it('sends empty secret fields so the Host keeps the stored values', () => {
    const form = createConfigForm(base)
    const payload = buildSyncConfig(form, base)
    expect(payload.webdav.password).toBe('')
    expect(payload.webdav.token).toBe('')
    expect(payload.s3.secretAccessKey).toBe('')
    expect(payload.s3.sessionToken).toBe('')
    expect(payload.git.tokenEnvVar).toBe('GITHUB_TOKEN')
  })

  it('passes a newly typed secret through without trimming it', () => {
    const form = patchWebdav(createConfigForm(base), { password: '  new pass  ' })
    const payload = buildSyncConfig(form, base)
    expect(payload.webdav.password).toBe('  new pass  ')
    expect(hasTypedSecret(form)).toBe(true)
  })

  it('trims identifiers but keeps all backend blocks', () => {
    const form = patchGit(createConfigForm(base), { repoUrl: '  https://example.com/x.git  ' })
    const payload = buildSyncConfig(form, base)
    expect(payload.git.repoUrl).toBe('https://example.com/x.git')
    expect(payload.webdav.url).toBe(base.webdav.url)
    expect(payload.s3.bucket).toBe(base.s3.bucket)
    expect(payload.backendKind).toBe('webdav')
  })

  it('preserves item exclusions and the active profile', () => {
    const form = createConfigForm(base)
    const payload = buildSyncConfig(form, base)
    expect(payload.excluded.plugins).toEqual(['local:notes'])
    expect(payload.profiles).toEqual(['default', 'work'])
  })

  it('falls back for a cleared device name and branch', () => {
    const form = patchGit(setDeviceName(createConfigForm(base), '   '), { branch: '  ' })
    const payload = buildSyncConfig(form, base)
    expect(payload.deviceName).toBe(base.deviceName)
    expect(payload.git.branch).toBe(base.git.branch)
  })

  it('sanitizes the automatic-sync numbers before sending them', () => {
    const form = patchAutoSync(createConfigForm(base), {
      intervalMinutes: -10,
      startupDelayMs: 99_999_999,
      debounceMs: 1_500.6,
    })
    const payload = buildSyncConfig(form, base)
    expect(payload.autoSync.intervalMinutes).toBe(0)
    expect(payload.autoSync.startupDelayMs).toBe(MAX_DELAY_MS)
    expect(payload.autoSync.debounceMs).toBe(1501)
  })
})

describe('sanitizeAutoSync', () => {
  it('clamps and rounds every number', () => {
    const sanitized = sanitizeAutoSync({
      enabled: true,
      mode: 'backup',
      intervalMinutes: MAX_INTERVAL_MINUTES + 1,
      startupDelayMs: -1,
      onStartup: true,
      onPluginChange: true,
      debounceMs: Number.NaN,
    })
    expect(sanitized.intervalMinutes).toBe(MAX_INTERVAL_MINUTES)
    expect(sanitized.startupDelayMs).toBe(0)
    expect(sanitized.debounceMs).toBe(0)
    expect(sanitized.mode).toBe('backup')
  })
})

describe('second/millisecond conversion', () => {
  it('rounds both ways and refuses negatives', () => {
    expect(msToSeconds(15_000)).toBe(15)
    expect(msToSeconds(0)).toBe(0)
    expect(msToSeconds(-5)).toBe(0)
    expect(msToSeconds(Number.NaN)).toBe(0)
    expect(secondsToMs(15)).toBe(15_000)
    expect(secondsToMs(-1)).toBe(0)
    expect(secondsToMs(Number.NaN)).toBe(0)
  })

  it('round-trips whole seconds', () => {
    expect(msToSeconds(secondsToMs(42))).toBe(42)
  })
})
