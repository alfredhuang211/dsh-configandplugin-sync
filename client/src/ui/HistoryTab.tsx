/**
 * History tab: the store's revision list with a two-step rollback.
 *
 * Clicking "Restore this revision" opens a confirmation dialog in `Page`; the
 * tab never calls the Host directly. That keeps every local overwrite behind an
 * explicit confirmation, which is the same rule the Sync tab follows.
 * @module ui/HistoryTab
 */

import type { ReactElement } from 'react'
import type { HistoryEntry, LastOperation } from '../../../src/types.js'
import type { Translate } from '../i18n'
import {
  formatCount,
  formatDateTime,
  formatRevision,
  operationLabelKey,
  resultTone,
} from '../format'
import { Badge, Banner, Button, Card, Empty, LinkButton, Loading } from './controls'

/** Props for {@link HistoryTab}. */
export interface HistoryTabProps {
  t: Translate
  entries: HistoryEntry[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onRollback: (entry: HistoryEntry) => void
  busy: boolean
  lastOperation: LastOperation | null
}

/** One revision row. */
function HistoryRow(props: {
  t: Translate
  entry: HistoryEntry
  busy: boolean
  onRollback: (entry: HistoryEntry) => void
}): ReactElement {
  const { t, entry } = props
  const short = formatRevision(entry.shortCommit === '' ? entry.commit : entry.shortCommit, t('notAvailable'))
  const operationKey = operationLabelKey(entry.operation)
  const dotClass =
    resultTone(entry.result) === 'success'
      ? 'dcs-dot dcs-dotOk'
      : resultTone(entry.result) === 'error'
        ? 'dcs-dot dcs-dotFail'
        : 'dcs-dot dcs-dotIdle'
  return (
    <li className="dcs-listItem">
      <span className={dotClass} aria-hidden="true" />
      <div className="dcs-listMain">
        <div className="dcs-listTop">
          <span className="dcs-listTitle dcs-mono">{short}</span>
          <Badge tone="idle">{operationKey === null ? entry.operation : t(operationKey)}</Badge>
          {entry.result === undefined || entry.result === '' ? null : (
            <Badge tone={resultTone(entry.result)}>
              {resultTone(entry.result) === 'success' ? t('resultOk') : t('resultFailed')}
            </Badge>
          )}
        </div>
        {entry.subject === '' ? null : <span className="dcs-listSubject">{entry.subject}</span>}
        <div className="dcs-listMeta">
          <span>{formatDateTime(entry.date, t('notAvailable'))}</span>
          <span>{entry.deviceName === undefined || entry.deviceName === '' ? t('historyNoDevice') : entry.deviceName}</span>
          {entry.profile === undefined || entry.profile === '' ? null : (
            <span>
              {t('historyColProfile')}: {entry.profile}
            </span>
          )}
          {entry.itemCount === undefined ? null : (
            <span>{t('historyColItems')}: {formatCount(entry.itemCount, t('notAvailable'))}</span>
          )}
        </div>
      </div>
      <Button
        small
        variant="danger"
        disabled={props.busy}
        ariaLabel={t('historyRollbackAria', { revision: short })}
        onClick={() => {
          props.onRollback(entry)
        }}
      >
        {t('historyRollback')}
      </Button>
    </li>
  )
}

/** Render the history tab. */
export function HistoryTab(props: HistoryTabProps): ReactElement {
  const { t, entries, lastOperation } = props
  const lastOperationKey = lastOperation === null ? null : operationLabelKey(lastOperation.operation)
  return (
    <Card
      title={t('historyTitle')}
      description={t('historyDesc')}
      trailing={
        <div className="dcs-cardActions">
          <Badge tone="idle">{t('historyCount', { count: formatCount(entries.length, '0') })}</Badge>
          <Button small onClick={props.onRefresh} disabled={props.loading} loading={props.loading}>
            {t('historyRefresh')}
          </Button>
        </div>
      }
    >
      {props.error === null ? null : (
        <Banner tone="error">
          {t('historyLoadFailed', { message: props.error })}{' '}
          <LinkButton onClick={props.onRefresh}>{t('retry')}</LinkButton>
        </Banner>
      )}

      {props.loading && entries.length === 0 ? (
        <Loading text={t('loading')} />
      ) : entries.length === 0 ? (
        <Empty text={t('historyEmpty')} />
      ) : (
        <ul className="dcs-list">
          {entries.map(entry => (
            <HistoryRow
              key={entry.commit}
              t={t}
              entry={entry}
              busy={props.busy}
              onRollback={props.onRollback}
            />
          ))}
        </ul>
      )}

      {lastOperation === null ? null : (
        <p className="dcs-hint">
          {t('historyLastOperation')}
          {' · '}
          {lastOperationKey === null ? lastOperation.operation : t(lastOperationKey)}
          {' · '}
          {formatDateTime(lastOperation.at, t('notAvailable'))}
          {' · '}
          {lastOperation.ok ? t('resultOk') : t('resultFailed')}
          {lastOperation.revision === null || lastOperation.revision === undefined
            ? ''
            : ` · ${t('opRevision', { revision: formatRevision(lastOperation.revision, t('notAvailable')) })}`}
        </p>
      )}
    </Card>
  )
}
