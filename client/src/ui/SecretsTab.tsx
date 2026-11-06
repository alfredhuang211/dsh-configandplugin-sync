/**
 * Secrets tab: presence only, never a value.
 *
 * The page deliberately cannot show, log, or submit a secret value. It shows
 * whether the remote store holds an encrypted envelope, when it was created,
 * how many references it holds, the names of the local references and records,
 * and a passphrase verification box that sends the passphrase once and clears
 * it immediately.
 * @module ui/SecretsTab
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { SecretsStatusResponse } from '../../../src/http/api-types.js'
import type { Translate } from '../i18n'
import { errorText } from '../api'
import { formatCount, formatDateTime } from '../format'
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  KeyValue,
  LinkButton,
  Loading,
  TextInput,
} from './controls'

/** Verification outcome shown below the passphrase box. */
type UnlockFeedback = { tone: 'success' | 'warn' | 'error'; text: string }

/** Props for {@link SecretsTab}. */
export interface SecretsTabProps {
  t: Translate
  status: SecretsStatusResponse | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  /** The configured passphrase environment-variable name (a name, never a value). */
  envVarName: string
  onUnlock: (passphrase: string) => Promise<{ ok: boolean; refCount: number; createdAt: string }>
  /** Store the passphrase in the local `0600` file. */
  onSavePassphrase: (passphrase: string) => Promise<void>
  /** Remove the local passphrase file. */
  onClearPassphrase: () => Promise<void>
  /** True while a passphrase write/clear is in flight. */
  passphraseBusy: boolean
}

/** Human label for where the available passphrase came from. */
function sourceLabel(
  t: Translate,
  source: SecretsStatusResponse['passphraseSource'] | undefined,
): string {
  if (source === 'env') return t('secretsSourceEnv')
  if (source === 'file') return t('secretsSourceFile')
  if (source === 'explicit') return t('secretsSourceExplicit')
  return t('notAvailable')
}

/** Render the secrets tab. */
export function SecretsTab(props: SecretsTabProps): ReactElement {
  const { t, status } = props
  const [passphrase, setPassphrase] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [feedback, setFeedback] = useState<UnlockFeedback | null>(null)
  const [localPassphrase, setLocalPassphrase] = useState('')
  const [saveFeedback, setSaveFeedback] = useState<UnlockFeedback | null>(null)

  async function saveLocal(): Promise<void> {
    if (props.passphraseBusy) return
    setSaveFeedback(null)
    try {
      await props.onSavePassphrase(localPassphrase)
      setSaveFeedback({ tone: 'success', text: t('secretsPassphraseSaved') })
    } catch (error) {
      setSaveFeedback({ tone: 'error', text: t('secretsPassphraseSaveFailed', { message: errorText(error) }) })
    } finally {
      setLocalPassphrase('')
    }
  }

  async function clearLocal(): Promise<void> {
    if (props.passphraseBusy) return
    setSaveFeedback(null)
    try {
      await props.onClearPassphrase()
      setSaveFeedback({ tone: 'success', text: t('secretsPassphraseCleared') })
    } catch (error) {
      setSaveFeedback({ tone: 'error', text: t('secretsPassphraseSaveFailed', { message: errorText(error) }) })
    }
  }

  async function verify(): Promise<void> {
    if (verifying) return
    setVerifying(true)
    setFeedback(null)
    try {
      const result = await props.onUnlock(passphrase)
      if (result.ok) {
        setFeedback({ tone: 'success', text: t('secretsUnlockOk', { count: result.refCount }) })
      } else {
        setFeedback({ tone: 'warn', text: t('secretsUnlockFail') })
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: t('secretsUnlockFailed', { message: errorText(error) }) })
    } finally {
      // Never keep the passphrase in component state after the attempt.
      setPassphrase('')
      setVerifying(false)
    }
  }

  return (
    <>
      <Card
        title={t('secretsTitle')}
        description={t('secretsDesc')}
        trailing={
          <Button small onClick={props.onRefresh} disabled={props.loading} loading={props.loading}>
            {t('secretsRefresh')}
          </Button>
        }
      >
        <Banner tone="idle">{t('secretsNoValueNotice')}</Banner>

        {props.error === null ? null : (
          <Banner tone="error">
            {t('secretsLoadFailed', { message: props.error })}{' '}
            <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
          </Banner>
        )}

        {status === null ? (
          props.error === null ? <Loading text={t('loading')} /> : null
        ) : (
          <>
            <div className="dcs-btnRow">
              <Badge tone={status.stored ? 'success' : 'idle'}>
                {status.stored ? t('secretsStored') : t('secretsNotStored')}
              </Badge>
              <Badge tone={status.passphraseAvailable ? 'success' : 'warn'}>
                {status.passphraseAvailable ? t('secretsPassphraseAvailable') : t('secretsPassphraseUnavailable')}
              </Badge>
            </div>

            <KeyValue
              items={[
                {
                  label: t('secretsCreatedAtLabel'),
                  value: formatDateTime(status.createdAt, t('notAvailable')),
                },
                {
                  label: t('secretsRefCountLabel'),
                  value: formatCount(status.refCount, t('notAvailable')),
                },
                {
                  label: t('configPassphraseEnvVar'),
                  value:
                    props.envVarName.trim() === '' ? (
                      <span className="dcs-muted">{t('secretsEnvVarNotSet')}</span>
                    ) : (
                      <span className="dcs-mono">{props.envVarName}</span>
                    ),
                  wrap: true,
                },
              ]}
            />

            {props.envVarName.trim() === '' ? null : (
              <p className="dcs-hint">{t('secretsPassphraseHint', { name: props.envVarName })}</p>
            )}

            <div className="dcs-mcpField">
              <span className="dcs-mcpFieldLabel">
                {t('secretsLocalRefs', { count: formatCount(status.localRefs.length, '0') })}
              </span>
              {status.localRefs.length === 0 ? (
                <Empty text={t('secretsLocalRefsEmpty')} />
              ) : (
                <span className="dcs-nameList">
                  {status.localRefs.map(name => (
                    <span key={`ref:${name}`} className="dcs-nameChip">
                      {name}
                    </span>
                  ))}
                </span>
              )}
            </div>

            <div className="dcs-mcpField">
              <span className="dcs-mcpFieldLabel">
                {t('secretsLocalRecords', { count: formatCount(status.localRecords.length, '0') })}
              </span>
              {status.localRecords.length === 0 ? (
                <Empty text={t('secretsLocalRecordsEmpty')} />
              ) : (
                <span className="dcs-nameList">
                  {status.localRecords.map(name => (
                    <span key={`record:${name}`} className="dcs-nameChip">
                      {name}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      <Card
        title={t('secretsLocalPassphraseTitle')}
        description={t('secretsLocalPassphraseDesc')}
        trailing={
          <Badge tone={status !== null && status.passphraseAvailable ? 'success' : 'warn'}>
            {status !== null && status.passphraseAvailable
              ? t('secretsLocalPassphraseAvailable', { source: sourceLabel(t, status.passphraseSource) })
              : t('secretsPassphraseUnavailable')}
          </Badge>
        }
      >
        <Banner tone="idle">{t('secretsLocalPassphraseWhy')}</Banner>
        <div className="dcs-inlineRow">
          <TextInput
            id="dcs-local-passphrase"
            type="password"
            value={localPassphrase}
            disabled={props.passphraseBusy}
            placeholder={t('secretsPassphrasePlaceholder')}
            onChange={setLocalPassphrase}
          />
          <Button onClick={() => void saveLocal()} disabled={props.passphraseBusy || localPassphrase === ''} loading={props.passphraseBusy}>
            {t('secretsLocalPassphraseSave')}
          </Button>
          <Button onClick={() => void clearLocal()} disabled={props.passphraseBusy}>
            {t('secretsLocalPassphraseClear')}
          </Button>
        </div>
        {saveFeedback === null ? null : <Banner tone={saveFeedback.tone}>{saveFeedback.text}</Banner>}
      </Card>

      <Card title={t('secretsUnlockTitle')} description={t('secretsUnlockDesc')}>
        <Field id="dcs-secrets-passphrase" label={t('secretsPassphraseLabel')}>
          <div className="dcs-inlineRow">
            <TextInput
              id="dcs-secrets-passphrase"
              type="password"
              value={passphrase}
              disabled={verifying}
              autoComplete="new-password"
              placeholder={t('secretsPassphrasePlaceholder')}
              onChange={setPassphrase}
            />
            <Button
              onClick={() => {
                void verify()
              }}
              disabled={verifying}
              loading={verifying}
            >
              {verifying ? t('secretsUnlocking') : t('secretsUnlock')}
            </Button>
          </div>
        </Field>
        {feedback === null ? null : <Banner tone={feedback.tone}>{feedback.text}</Banner>}
      </Card>
    </>
  )
}
