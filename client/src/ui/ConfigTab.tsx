/**
 * Config tab: the storage backend, its credential sources, the synchronized
 * profiles and sections, and the automatic-sync policy.
 *
 * The tab is fully controlled: `Page` owns the form state so an unsaved edit
 * survives a tab switch and a background status poll never overwrites it.
 * Secret fields are write-only — they start empty (the Host blanks them in
 * every response) and an empty value means "keep what is stored".
 * @module ui/ConfigTab
 */

import type { ReactElement } from 'react'
import type {
  AutoSyncConfig,
  AutoSyncMode,
  BackendKind,
  ConnectionTestResult,
  GitAuthMode,
  SectionScopes,
  SyncConfigView,
} from '../../../src/types.js'
import type { ConfigForm, GitFormFields, S3FormFields, WebdavFormFields } from '../config-form'
import {
  MAX_DELAY_MS,
  MAX_INTERVAL_MINUTES,
  msToSeconds,
  passphraseEnvVarIssue,
  secondsToMs,
} from '../config-form'
import type { Translate } from '../i18n'
import { formatRevision } from '../format'
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  Loading,
  NumberInput,
  Segmented,
  Select,
  Switch,
  TextInput,
} from './controls'

/** The six section switches, in the order the cards list them. */
const SCOPE_ITEMS: ReadonlyArray<{ key: keyof SectionScopes; labelKey: string; hintKey?: string }> = [
  { key: 'dshConfig', labelKey: 'sectionDshConfig' },
  { key: 'providers', labelKey: 'sectionProviders' },
  { key: 'plugins', labelKey: 'sectionPlugins' },
  { key: 'pluginConfigs', labelKey: 'sectionPluginConfigs' },
  { key: 'secrets', labelKey: 'sectionSecrets', hintKey: 'configScopesSecretsHint' },
  { key: 'mcp', labelKey: 'sectionMcp' },
]

/** Props for {@link ConfigTab}. */
export interface ConfigTabProps {
  t: Translate
  view: SyncConfigView | null
  form: ConfigForm | null
  dirty: boolean
  saving: boolean
  testing: boolean
  testResult: ConnectionTestResult | null
  testError: string | null
  savingAuto: boolean
  onBackendKind: (kind: BackendKind) => void
  onGit: (patch: Partial<GitFormFields>) => void
  onWebdav: (patch: Partial<WebdavFormFields>) => void
  onS3: (patch: Partial<S3FormFields>) => void
  onProfile: (profile: string) => void
  onScope: (key: keyof SectionScopes, value: boolean) => void
  onAuto: (patch: Partial<AutoSyncConfig>) => void
  onDeviceName: (value: string) => void
  onPassphraseEnvVar: (value: string) => void
  onTest: () => void
  onSave: () => void
  onSaveAuto: () => void
}

/** One label/control row with its hint. */
function Row(props: { id: string; label: string; hint?: string; children: ReactElement }): ReactElement {
  return (
    <div className="dcs-formRow">
      <span className="dcs-formRowLabel">
        <label htmlFor={props.id}>{props.label}</label>
      </span>
      <div className="dcs-formRowControl">
        {props.children}
        {props.hint === undefined ? null : <span className="dcs-formRowHint">{props.hint}</span>}
      </div>
    </div>
  )
}

/** Git backend fields. */
function GitFields(props: {
  t: Translate
  form: ConfigForm
  view: SyncConfigView
  disabled: boolean
  onGit: (patch: Partial<GitFormFields>) => void
}): ReactElement {
  const { t, form, view } = props
  const git = form.git
  const authOptions: ReadonlyArray<{ value: GitAuthMode; label: string }> = [
    { value: 'credential-helper', label: t('configAuthHelper') },
    { value: 'ssh', label: t('configAuthSsh') },
    { value: 'https-token', label: t('configAuthHttpsToken') },
  ]
  const authHint =
    git.authMode === 'ssh'
      ? t('configAuthSshHint')
      : git.authMode === 'https-token'
        ? t('configAuthHttpsTokenHint')
        : t('configAuthHelperHint')
  return (
    <div className="dcs-formRows">
      <Row id="dcs-git-url" label={t('configRepoUrl')} hint={t('configRepoUrlHint')}>
        <TextInput
          id="dcs-git-url"
          value={git.repoUrl}
          disabled={props.disabled}
          inputMode="url"
          placeholder="https://github.com/me/dsh-store.git"
          onChange={value => {
            props.onGit({ repoUrl: value })
          }}
        />
      </Row>
      <Row id="dcs-git-branch" label={t('configBranch')}>
        <TextInput
          id="dcs-git-branch"
          value={git.branch}
          disabled={props.disabled}
          placeholder="main"
          onChange={value => {
            props.onGit({ branch: value })
          }}
        />
      </Row>
      <Row id="dcs-git-auth" label={t('configAuthMode')} hint={authHint}>
        <Select<GitAuthMode>
          id="dcs-git-auth"
          value={git.authMode}
          options={authOptions}
          disabled={props.disabled}
          onChange={value => {
            props.onGit({ authMode: value })
          }}
        />
      </Row>
      {git.authMode === 'https-token' ? (
        <Row id="dcs-git-token-env" label={t('configTokenEnvVar')} hint={t('configTokenEnvVarHint')}>
          <div className="dcs-inputWithBadge">
            <TextInput
              id="dcs-git-token-env"
              value={git.tokenEnvVar}
              disabled={props.disabled}
              placeholder="GITHUB_TOKEN"
              onChange={value => {
                props.onGit({ tokenEnvVar: value })
              }}
            />
            <Badge tone={view.tokenAvailable ? 'success' : 'warn'}>
              {view.tokenAvailable ? t('configTokenAvailable') : t('configTokenUnavailable')}
            </Badge>
          </div>
        </Row>
      ) : null}
      <Row id="dcs-git-username" label={t('configUsername')} hint={t('configUsernameHint')}>
        <TextInput
          id="dcs-git-username"
          value={git.username}
          disabled={props.disabled}
          autoComplete="username"
          onChange={value => {
            props.onGit({ username: value })
          }}
        />
      </Row>
    </div>
  )
}

/** WebDAV backend fields. */
function WebdavFields(props: {
  t: Translate
  form: ConfigForm
  disabled: boolean
  onWebdav: (patch: Partial<WebdavFormFields>) => void
}): ReactElement {
  const { t, form } = props
  const webdav = form.webdav
  return (
    <div className="dcs-formRows">
      <Row id="dcs-webdav-url" label={t('configWebdavUrl')} hint={t('configWebdavUrlHint')}>
        <TextInput
          id="dcs-webdav-url"
          value={webdav.url}
          disabled={props.disabled}
          inputMode="url"
          placeholder="https://dav.example.com/dav/dsh"
          onChange={value => {
            props.onWebdav({ url: value })
          }}
        />
      </Row>
      <Row id="dcs-webdav-user" label={t('configWebdavUsername')}>
        <TextInput
          id="dcs-webdav-user"
          value={webdav.username}
          disabled={props.disabled}
          autoComplete="username"
          onChange={value => {
            props.onWebdav({ username: value })
          }}
        />
      </Row>
      <Row id="dcs-webdav-password" label={t('configWebdavPassword')} hint={t('configWebdavPasswordHint')}>
        <TextInput
          id="dcs-webdav-password"
          type="password"
          value={webdav.password}
          disabled={props.disabled}
          autoComplete="new-password"
          onChange={value => {
            props.onWebdav({ password: value })
          }}
        />
      </Row>
      <Row id="dcs-webdav-token" label={t('configWebdavToken')} hint={t('configWebdavTokenHint')}>
        <TextInput
          id="dcs-webdav-token"
          type="password"
          value={webdav.token}
          disabled={props.disabled}
          autoComplete="new-password"
          onChange={value => {
            props.onWebdav({ token: value })
          }}
        />
      </Row>
    </div>
  )
}

/** S3 backend fields. */
function S3Fields(props: {
  t: Translate
  form: ConfigForm
  disabled: boolean
  onS3: (patch: Partial<S3FormFields>) => void
}): ReactElement {
  const { t, form } = props
  const s3 = form.s3
  return (
    <div className="dcs-formRows">
      <Row id="dcs-s3-endpoint" label={t('configS3Endpoint')} hint={t('configS3EndpointHint')}>
        <TextInput
          id="dcs-s3-endpoint"
          value={s3.endpoint}
          disabled={props.disabled}
          inputMode="url"
          placeholder="https://s3.amazonaws.com"
          onChange={value => {
            props.onS3({ endpoint: value })
          }}
        />
      </Row>
      <Row id="dcs-s3-region" label={t('configS3Region')}>
        <TextInput
          id="dcs-s3-region"
          value={s3.region}
          disabled={props.disabled}
          placeholder="us-east-1"
          onChange={value => {
            props.onS3({ region: value })
          }}
        />
      </Row>
      <Row id="dcs-s3-bucket" label={t('configS3Bucket')}>
        <TextInput
          id="dcs-s3-bucket"
          value={s3.bucket}
          disabled={props.disabled}
          onChange={value => {
            props.onS3({ bucket: value })
          }}
        />
      </Row>
      <Row id="dcs-s3-prefix" label={t('configS3Prefix')} hint={t('configS3PrefixHint')}>
        <TextInput
          id="dcs-s3-prefix"
          value={s3.prefix}
          disabled={props.disabled}
          placeholder="dsh-sync"
          onChange={value => {
            props.onS3({ prefix: value })
          }}
        />
      </Row>
      <Row id="dcs-s3-access-key" label={t('configS3AccessKey')}>
        <TextInput
          id="dcs-s3-access-key"
          value={s3.accessKeyId}
          disabled={props.disabled}
          autoComplete="username"
          onChange={value => {
            props.onS3({ accessKeyId: value })
          }}
        />
      </Row>
      <Row id="dcs-s3-secret" label={t('configS3Secret')} hint={t('configS3SecretHint')}>
        <TextInput
          id="dcs-s3-secret"
          type="password"
          value={s3.secretAccessKey}
          disabled={props.disabled}
          autoComplete="new-password"
          onChange={value => {
            props.onS3({ secretAccessKey: value })
          }}
        />
      </Row>
      <Row id="dcs-s3-session" label={t('configS3SessionToken')} hint={t('configS3SessionTokenHint')}>
        <TextInput
          id="dcs-s3-session"
          type="password"
          value={s3.sessionToken}
          disabled={props.disabled}
          autoComplete="new-password"
          onChange={value => {
            props.onS3({ sessionToken: value })
          }}
        />
      </Row>
      <div className="dcs-formRow">
        <span className="dcs-formRowLabel">{t('configS3ForcePathStyle')}</span>
        <div className="dcs-formRowControl">
          <Switch
            label={t('configS3ForcePathStyle')}
            hint={t('configS3ForcePathStyleHint')}
            checked={s3.forcePathStyle}
            disabled={props.disabled}
            onChange={checked => {
              props.onS3({ forcePathStyle: checked })
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** Render the config tab. */
export function ConfigTab(props: ConfigTabProps): ReactElement {
  const { t, view, form } = props

  if (view === null || form === null) {
    return (
      <Card title={t('configTitle')} description={t('configDesc')}>
        <Loading text={t('configLoadHint')} />
      </Card>
    )
  }

  const backendOptions: ReadonlyArray<{ value: BackendKind; label: string; title: string }> = [
    { value: 'git', label: t('backendGit'), title: t('configBackendHintGit') },
    { value: 'webdav', label: t('backendWebdav'), title: t('configBackendHintWebdav') },
    { value: 's3', label: t('backendS3'), title: t('configBackendHintS3') },
  ]
  const backendHint =
    form.backendKind === 'git'
      ? t('configBackendHintGit')
      : form.backendKind === 'webdav'
        ? t('configBackendHintWebdav')
        : t('configBackendHintS3')

  const passphraseIssue = passphraseEnvVarIssue(form.passphraseEnvVar)
  const excludedTotal = Object.values(form.excluded).reduce((sum, ids) => sum + ids.length, 0)
  const autoModeOptions: ReadonlyArray<{ value: AutoSyncMode; label: string }> = [
    { value: 'two-way', label: t('autoModeTwoWay') },
    { value: 'backup', label: t('autoModeBackup') },
    { value: 'restore', label: t('autoModeRestore') },
  ]
  const auto = form.autoSync

  return (
    <>
      <Card
        title={t('configTitle')}
        description={t('configDesc')}
        trailing={
          <div className="dcs-cardActions">
            {props.dirty ? <Badge tone="warn">{t('configUnsaved')}</Badge> : null}
            <Button variant="primary" onClick={props.onSave} disabled={props.saving} loading={props.saving}>
              {props.saving ? t('configSaving') : t('configSave')}
            </Button>
          </div>
        }
      >
        <div className="dcs-field">
          <span className="dcs-label">{t('configBackend')}</span>
          <Segmented<BackendKind>
            label={t('configBackend')}
            value={form.backendKind}
            disabled={props.saving}
            options={backendOptions}
            onChange={props.onBackendKind}
          />
          <span className="dcs-hint">{backendHint}</span>
        </div>

        {form.backendKind === 'git' ? (
          <GitFields t={t} form={form} view={view} disabled={props.saving} onGit={props.onGit} />
        ) : form.backendKind === 'webdav' ? (
          <WebdavFields t={t} form={form} disabled={props.saving} onWebdav={props.onWebdav} />
        ) : (
          <S3Fields t={t} form={form} disabled={props.saving} onS3={props.onS3} />
        )}

        <div className="dcs-btnRow">
          <Button onClick={props.onTest} disabled={props.testing || props.saving} loading={props.testing}>
            {props.testing ? t('configTesting') : t('configTest')}
          </Button>
        </div>

        {props.testResult === null ? null : (
          <Banner tone={props.testResult.ok ? 'success' : 'error'}>
            <span>
              {props.testResult.ok
                ? t('configTestOk', { message: props.testResult.message })
                : t('configTestFail', { message: props.testResult.message })}
            </span>
            <span className="dcs-small">
              {props.testResult.revision === null
                ? null
                : `${t('configTestRevision', {
                    revision: formatRevision(props.testResult.revision, t('notAvailable')),
                  })} `}
              {props.testResult.authMethod === undefined || props.testResult.authMethod === ''
                ? null
                : t('configTestAuth', { method: props.testResult.authMethod })}
            </span>
          </Banner>
        )}

        {props.testError === null ? null : (
          <Banner tone="error">{t('configTestFailed', { message: props.testError })}</Banner>
        )}
      </Card>

      <Card title={t('configDeviceTitle')}>
        <div className="dcs-formRows">
          <Row id="dcs-device-name" label={t('configDeviceName')} hint={t('configDeviceNameHint')}>
            <TextInput
              id="dcs-device-name"
              value={form.deviceName}
              disabled={props.saving}
              onChange={props.onDeviceName}
            />
          </Row>
          <div className="dcs-formRow">
            <span className="dcs-formRowLabel">{t('configActiveProfile')}</span>
            <div className="dcs-formRowControl">
              <span className="dcs-hint dcs-mono">{view.activeProfile}</span>
            </div>
          </div>
          <div className="dcs-formRow">
            <span className="dcs-formRowLabel">
              <label htmlFor="dcs-profiles-group">{t('configProfiles')}</label>
            </span>
            <div className="dcs-formRowControl">
              <div className="dcs-checkRowGroup" id="dcs-profiles-group" role="group" aria-label={t('configProfiles')}>
                {view.availableProfiles.length === 0 ? (
                  <Empty text={t('configNoProfiles')} />
                ) : (
                  view.availableProfiles.map((profile, index) => (
                    <Checkbox
                      key={profile}
                      id={`dcs-profile-${index}`}
                      checked={form.profiles.includes(profile)}
                      onChange={() => {
                        props.onProfile(profile)
                      }}
                      disabled={props.saving || profile === view.activeProfile}
                      label={
                        profile === view.activeProfile
                          ? `${profile} (${t('configActiveProfile')})`
                          : profile
                      }
                    />
                  ))
                )}
              </div>
              <span className="dcs-formRowHint">{t('configProfilesHint')}</span>
            </div>
          </div>
          <div className="dcs-formRow">
            <span className="dcs-formRowLabel">{t('configDataDir')}</span>
            <div className="dcs-formRowControl">
              <span className="dcs-hint dcs-mono">{view.dataDir}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('configScopesTitle')} description={t('configScopesDesc')}>
        <div className="dcs-formRows">
          {SCOPE_ITEMS.map(item => (
            <Switch
              key={item.key}
              label={t(item.labelKey)}
              hint={item.hintKey === undefined ? undefined : t(item.hintKey)}
              checked={form.scopes[item.key]}
              disabled={props.saving}
              onChange={checked => {
                props.onScope(item.key, checked)
              }}
            />
          ))}
          <Row
            id="dcs-passphrase-env"
            label={t('configPassphraseEnvVar')}
            hint={t('configPassphraseEnvVarHint')}
          >
            <div className="dcs-inputWithBadge">
              <TextInput
                id="dcs-passphrase-env"
                value={form.passphraseEnvVar}
                disabled={props.saving}
                placeholder="DSH_SYNC_PASSPHRASE"
                onChange={props.onPassphraseEnvVar}
              />
              <Badge tone={view.passphraseAvailable ? 'success' : 'warn'}>
                {view.passphraseAvailable ? t('configPassphraseAvailable') : t('configPassphraseUnavailable')}
              </Badge>
            </div>
          </Row>
          {passphraseIssue === 'invalid' ? (
            <Banner tone="error">{t('configPassphraseEnvVarInvalid')}</Banner>
          ) : passphraseIssue === 'empty' || !view.passphraseAvailable ? (
            <Banner tone="warn">
              {t('configPassphraseEnvVarNotSet', {
                name: form.passphraseEnvVar.trim() === '' ? 'DSH_SYNC_PASSPHRASE' : form.passphraseEnvVar.trim(),
              })}
            </Banner>
          ) : null}
          <p className="dcs-hint">{t('configExcludedCount', { count: excludedTotal })}</p>
        </div>
      </Card>

      <Card
        title={t('configAutoTitle')}
        description={t('configAutoDesc')}
        trailing={
          <Button onClick={props.onSaveAuto} disabled={props.savingAuto} loading={props.savingAuto}>
            {props.savingAuto ? t('autoSaving') : t('autoSave')}
          </Button>
        }
      >
        <Switch
          label={t('autoEnabled')}
          hint={t('autoEnabledHint')}
          checked={auto.enabled}
          disabled={props.savingAuto}
          onChange={checked => {
            props.onAuto({ enabled: checked })
          }}
        />
        {auto.enabled ? (
          <>
            <div className="dcs-field">
              <span className="dcs-label">{t('autoMode')}</span>
              <Segmented<AutoSyncMode>
                label={t('autoMode')}
                value={auto.mode}
                disabled={props.savingAuto}
                options={autoModeOptions}
                onChange={value => {
                  props.onAuto({ mode: value })
                }}
              />
            </div>
            <div className="dcs-formRows">
              <Row id="dcs-auto-interval" label={t('autoInterval')} hint={t('autoIntervalHint')}>
                <div className="dcs-inlineRow">
                  <NumberInput
                    id="dcs-auto-interval"
                    value={auto.intervalMinutes}
                    min={0}
                    max={MAX_INTERVAL_MINUTES}
                    disabled={props.savingAuto}
                    ariaLabel={t('autoInterval')}
                    onChange={value => {
                      props.onAuto({ intervalMinutes: value })
                    }}
                  />
                  <span className="dcs-hint">{t('autoIntervalUnit')}</span>
                </div>
              </Row>
              <div className="dcs-formRow">
                <span className="dcs-formRowLabel">{t('autoStartup')}</span>
                <div className="dcs-formRowControl">
                  <Switch
                    label={t('autoStartup')}
                    hint={t('autoStartupHint')}
                    checked={auto.onStartup}
                    disabled={props.savingAuto}
                    onChange={checked => {
                      props.onAuto({ onStartup: checked })
                    }}
                  />
                </div>
              </div>
              <Row id="dcs-auto-delay" label={t('autoStartupDelay')} hint={t('autoStartupDelayHint')}>
                <div className="dcs-inlineRow">
                  <NumberInput
                    id="dcs-auto-delay"
                    value={msToSeconds(auto.startupDelayMs)}
                    min={0}
                    max={MAX_DELAY_MS / 1000}
                    disabled={props.savingAuto || !auto.onStartup}
                    ariaLabel={t('autoStartupDelay')}
                    onChange={seconds => {
                      props.onAuto({ startupDelayMs: secondsToMs(seconds) })
                    }}
                  />
                  <span className="dcs-hint">{t('autoStartupDelayUnit')}</span>
                </div>
              </Row>
              <div className="dcs-formRow">
                <span className="dcs-formRowLabel">{t('autoPluginChange')}</span>
                <div className="dcs-formRowControl">
                  <Switch
                    label={t('autoPluginChange')}
                    hint={t('autoPluginChangeHint')}
                    checked={auto.onPluginChange}
                    disabled={props.savingAuto}
                    onChange={checked => {
                      props.onAuto({ onPluginChange: checked })
                    }}
                  />
                </div>
              </div>
              <Row id="dcs-auto-debounce" label={t('autoDebounce')} hint={t('autoDebounceHint')}>
                <div className="dcs-inlineRow">
                  <NumberInput
                    id="dcs-auto-debounce"
                    value={msToSeconds(auto.debounceMs)}
                    min={0}
                    max={MAX_DELAY_MS / 1000}
                    disabled={props.savingAuto || !auto.onPluginChange}
                    ariaLabel={t('autoDebounce')}
                    onChange={seconds => {
                      props.onAuto({ debounceMs: secondsToMs(seconds) })
                    }}
                  />
                  <span className="dcs-hint">{t('autoDebounceUnit')}</span>
                </div>
              </Row>
            </div>
            <p className="dcs-hint">{t('autoBehaviorHint')}</p>
          </>
        ) : (
          <p className="dcs-hint">{t('autoOffHint')}</p>
        )}
      </Card>
    </>
  )
}
