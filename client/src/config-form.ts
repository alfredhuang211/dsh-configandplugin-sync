/**
 * Editable configuration form: the browser-side model of `SyncConfig`.
 *
 * Two deliberate rules make this module safe:
 *
 *  - **Secret fields start empty.** `webdav.password`, `webdav.token`,
 *    `s3.secretAccessKey` and `s3.sessionToken` are never copied out of the
 *    Host's view into renderable state, so no secret can reach the DOM or a
 *    React DevTools snapshot. An empty field means "keep the stored value",
 *    which is also the Host's save semantics; a non-empty field is a new value.
 *  - **The form is a superset.** All three backend blocks are kept while the
 *    user switches kind, so switching Git → S3 → Git never loses typed fields.
 *
 * All helpers are pure, so the form rules are unit tested without a DOM.
 * @module config-form
 */

import type {
  AutoSyncConfig,
  BackendKind,
  GitAuthMode,
  SectionId,
  SectionScopes,
  SyncConfig,
  SyncConfigView,
} from '../../src/types.js'

/** Git fields shown by the form. */
export interface GitFormFields {
  repoUrl: string
  branch: string
  authMode: GitAuthMode
  tokenEnvVar: string
  username: string
}

/** WebDAV fields shown by the form; the secrets start empty. */
export interface WebdavFormFields {
  url: string
  username: string
  /** Write-only: empty keeps the stored password. */
  password: string
  /** Write-only: empty keeps the stored token. */
  token: string
}

/** S3 fields shown by the form; the credentials start empty. */
export interface S3FormFields {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  /** Write-only: empty keeps the stored secret key. */
  secretAccessKey: string
  /** Write-only: empty keeps the stored session token. */
  sessionToken: string
  forcePathStyle: boolean
}

/** The complete editable configuration. */
export interface ConfigForm {
  backendKind: BackendKind
  git: GitFormFields
  webdav: WebdavFormFields
  s3: S3FormFields
  profiles: string[]
  scopes: SectionScopes
  passphraseEnvVar: string
  deviceName: string
  autoSync: AutoSyncConfig
  /** Item exclusions are not edited by this page; they are preserved on save. */
  excluded: Record<SectionId, string[]>
}

/** The four write-only secret fields, in one list for the "has changes" check. */
const SECRET_DEFAULTS = {
  password: '',
  token: '',
  secretAccessKey: '',
  sessionToken: '',
} as const

/** Highest interval the timer field accepts (one week). */
export const MAX_INTERVAL_MINUTES = 10_080

/** Highest startup delay / debounce the page accepts (ten minutes). */
export const MAX_DELAY_MS = 600_000

/** Build the editable form from the Host's effective configuration. */
export function createConfigForm(view: SyncConfigView): ConfigForm {
  return {
    backendKind: view.backendKind,
    git: {
      repoUrl: view.git.repoUrl,
      branch: view.git.branch,
      authMode: view.git.authMode,
      tokenEnvVar: view.git.tokenEnvVar,
      username: view.git.username,
    },
    webdav: {
      url: view.webdav.url,
      username: view.webdav.username,
      ...SECRET_DEFAULTS,
    },
    s3: {
      endpoint: view.s3.endpoint,
      region: view.s3.region,
      bucket: view.s3.bucket,
      prefix: view.s3.prefix,
      accessKeyId: view.s3.accessKeyId,
      ...SECRET_DEFAULTS,
      forcePathStyle: view.s3.forcePathStyle,
    },
    // The active profile is always synchronized; a view without profiles only
    // happens before the first status read, so fall back to it.
    profiles: view.profiles.length > 0 ? [...view.profiles] : [view.activeProfile],
    scopes: { ...view.scopes },
    passphraseEnvVar: view.passphraseEnvVar,
    deviceName: view.deviceName,
    autoSync: { ...view.autoSync },
    excluded: cloneExcluded(view.excluded),
  }
}

/** Deep-copy the per-section exclusion lists. */
function cloneExcluded(excluded: Record<SectionId, string[]>): Record<SectionId, string[]> {
  const copy = {} as Record<SectionId, string[]>
  for (const key of Object.keys(excluded) as SectionId[]) copy[key] = [...(excluded[key] ?? [])]
  return copy
}

/** Switch the active backend without touching the other blocks. */
export function setBackendKind(form: ConfigForm, kind: BackendKind): ConfigForm {
  return { ...form, backendKind: kind }
}

/** Patch Git fields. */
export function patchGit(form: ConfigForm, patch: Partial<GitFormFields>): ConfigForm {
  return { ...form, git: { ...form.git, ...patch } }
}

/** Patch WebDAV fields. */
export function patchWebdav(form: ConfigForm, patch: Partial<WebdavFormFields>): ConfigForm {
  return { ...form, webdav: { ...form.webdav, ...patch } }
}

/** Patch S3 fields. */
export function patchS3(form: ConfigForm, patch: Partial<S3FormFields>): ConfigForm {
  return { ...form, s3: { ...form.s3, ...patch } }
}

/** Patch the automatic-sync block. */
export function patchAutoSync(form: ConfigForm, patch: Partial<AutoSyncConfig>): ConfigForm {
  return { ...form, autoSync: { ...form.autoSync, ...patch } }
}

/** Set one section scope flag. */
export function setScope(form: ConfigForm, key: keyof SectionScopes, value: boolean): ConfigForm {
  return { ...form, scopes: { ...form.scopes, [key]: value } }
}

/**
 * Toggle a profile.
 *
 * The profile this process runs in is always synchronized: unchecking it is
 * ignored, and the resulting list is never empty.
 */
export function toggleProfile(form: ConfigForm, profile: string, activeProfile: string): ConfigForm {
  if (profile === activeProfile) return form
  const selected = new Set(form.profiles)
  if (selected.has(profile)) selected.delete(profile)
  else selected.add(profile)
  selected.add(activeProfile)
  return { ...form, profiles: [...selected] }
}

/** Set the device name. */
export function setDeviceName(form: ConfigForm, deviceName: string): ConfigForm {
  return { ...form, deviceName }
}

/** Set the passphrase environment-variable name. */
export function setPassphraseEnvVar(form: ConfigForm, passphraseEnvVar: string): ConfigForm {
  return { ...form, passphraseEnvVar }
}

/** Whether the user typed any new secret into the form. */
/**
 * Validate the passphrase *variable name* field.
 *
 * The field names an environment variable; the passphrase itself belongs in
 * `~/.dsh/.env`. Only a POSIX identifier can name a variable, so a value with
 * spaces, quotes or dashes is rejected inline instead of being saved into a
 * setting that can never resolve. (`alfred130211` is syntactically valid, which
 * is exactly why the page also warns when the named variable is not set.)
 */
export function passphraseEnvVarIssue(value: string): 'empty' | 'invalid' | null {
  const trimmed = value.trim()
  if (trimmed === '') return 'empty'
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? null : 'invalid'
}

export function hasTypedSecret(form: ConfigForm): boolean {
  return (
    form.webdav.password !== '' ||
    form.webdav.token !== '' ||
    form.s3.secretAccessKey !== '' ||
    form.s3.sessionToken !== ''
  )
}

/** Clamp one number field into the range the Host accepts. */
function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Normalize the automatic-sync numbers before they leave the page. */
export function sanitizeAutoSync(autoSync: AutoSyncConfig): AutoSyncConfig {
  return {
    enabled: autoSync.enabled,
    mode: autoSync.mode,
    intervalMinutes: clampInteger(autoSync.intervalMinutes, 0, MAX_INTERVAL_MINUTES),
    startupDelayMs: clampInteger(autoSync.startupDelayMs, 0, MAX_DELAY_MS),
    onStartup: autoSync.onStartup,
    onPluginChange: autoSync.onPluginChange,
    debounceMs: clampInteger(autoSync.debounceMs, 0, MAX_DELAY_MS),
  }
}

/** Milliseconds → whole seconds, for the two delay inputs. */
export function msToSeconds(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.round(ms / 1000))
}

/** Whole seconds → milliseconds, for the two delay inputs. */
export function secondsToMs(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0
  return Math.max(0, Math.round(seconds * 1000))
}

/**
 * Build the payload for `config/save`.
 *
 * Secret fields are passed through verbatim: the form starts them empty and an
 * empty value tells the Host to keep what it already stored. `excluded` and any
 * field this page does not edit come from the Host's current configuration.
 */
export function buildSyncConfig(form: ConfigForm, base: SyncConfig): SyncConfig {
  const branch = form.git.branch.trim()
  const deviceName = form.deviceName.trim()
  return {
    backendKind: form.backendKind,
    git: {
      kind: 'git',
      repoUrl: form.git.repoUrl.trim(),
      branch: branch === '' ? base.git.branch : branch,
      authMode: form.git.authMode,
      tokenEnvVar: form.git.tokenEnvVar.trim(),
      username: form.git.username.trim(),
    },
    webdav: {
      kind: 'webdav',
      url: form.webdav.url.trim(),
      username: form.webdav.username.trim(),
      // Never trim a password: leading/trailing spaces may be significant.
      password: form.webdav.password,
      token: form.webdav.token,
    },
    s3: {
      kind: 's3',
      endpoint: form.s3.endpoint.trim(),
      region: form.s3.region.trim(),
      bucket: form.s3.bucket.trim(),
      prefix: form.s3.prefix.trim(),
      accessKeyId: form.s3.accessKeyId.trim(),
      secretAccessKey: form.s3.secretAccessKey,
      sessionToken: form.s3.sessionToken,
      forcePathStyle: form.s3.forcePathStyle,
    },
    profiles: [...new Set(form.profiles)],
    scopes: { ...form.scopes },
    passphraseEnvVar: form.passphraseEnvVar.trim(),
    excluded: cloneExcluded(form.excluded),
    autoSync: sanitizeAutoSync(form.autoSync),
    deviceName: deviceName === '' ? base.deviceName : deviceName,
  }
}
