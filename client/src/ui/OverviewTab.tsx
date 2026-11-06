/**
 * Overview tab: the health of the whole synchronization in one screen.
 *
 * It answers four questions without a click: which backend and destination are
 * configured, how this device compares with the store (state pill and counts),
 * which section is behind or blocked, and what the last operation did.
 * @module ui/OverviewTab
 */

import type { ReactElement } from 'react'
import type { SectionStatus, StatusView } from '../../../src/types.js'
import type { Translate } from '../i18n'
import {
  backendLabelKey,
  formatBackendDestination,
  formatCount,
  formatDateTime,
  formatRevision,
  operationLabelKey,
  sectionLabelKey,
  stateLabelKey,
  stateTone,
} from '../format'
import { Badge, Banner, Button, Card, Empty, KeyValue, LinkButton, Loading } from './controls'

/** Props for {@link OverviewTab}. */
export interface OverviewTabProps {
  t: Translate
  status: StatusView | null
  refreshing: boolean
  sectionsRefreshing: boolean
  error: string | null
  onRefreshStatus: () => void
  onRefreshSections: () => void
  onGoConfig: () => void
  onGoSync: () => void
}

/** One section card: switch state, counts, and last update. */
function SectionCard(props: { t: Translate; section: SectionStatus }): ReactElement {
  const { t, section } = props
  const name = t(sectionLabelKey(section.section))
  const conflicts = section.conflictCount
  const changed = section.changedCount
  return (
    <article className="dcs-sectionCard" aria-label={t('sectionCardAria', { name })}>
      <div className="dcs-sectionHead">
        <span className="dcs-sectionName">{name}</span>
        <Badge tone={section.enabled ? 'success' : 'idle'}>
          {section.enabled ? t('sectionEnabled') : t('sectionDisabled')}
        </Badge>
      </div>
      <div className="dcs-sectionStats">
        <div className="dcs-sectionStat">
          <span className="dcs-sectionStatValue">{formatCount(section.localCount, t('notAvailable'))}</span>
          <span className="dcs-sectionStatLabel">{t('sectionLocalCount')}</span>
        </div>
        <div className="dcs-sectionStat">
          <span className="dcs-sectionStatValue">{formatCount(section.remoteCount, t('notAvailable'))}</span>
          <span className="dcs-sectionStatLabel">{t('sectionRemoteCount')}</span>
        </div>
        <div className="dcs-sectionStat">
          <span className={changed > 0 ? 'dcs-sectionStatValue dcs-sectionStatValueWarn' : 'dcs-sectionStatValue'}>
            {formatCount(changed, t('notAvailable'))}
          </span>
          <span className="dcs-sectionStatLabel">{t('sectionChanged')}</span>
        </div>
        <div className="dcs-sectionStat">
          <span className={conflicts > 0 ? 'dcs-sectionStatValue dcs-sectionStatValueError' : 'dcs-sectionStatValue'}>
            {formatCount(conflicts, t('notAvailable'))}
          </span>
          <span className="dcs-sectionStatLabel">{t('sectionConflictCount')}</span>
        </div>
      </div>
      <div className="dcs-sectionFoot">
        <span>
          {t('sectionLastUpdated')} {formatDateTime(section.lastUpdatedAt, t('never'))}
        </span>
        {section.blocked === undefined || section.blocked === '' ? null : (
          <Badge tone="warn" title={section.blocked}>
            {t('sectionBlocked')}
          </Badge>
        )}
      </div>
    </article>
  )
}

/** Render the overview tab. */
export function OverviewTab(props: OverviewTabProps): ReactElement {
  const { t, status } = props

  if (status === null) {
    return (
      <Card title={t('overviewTitle')} description={t('overviewDesc')}>
        {props.error === null ? (
          <Loading text={t('loading')} />
        ) : (
          <>
            <Banner tone="error">{t('overviewLoadFailed', { message: props.error })}</Banner>
            <div className="dcs-btnRow">
              <Button onClick={props.onRefreshStatus}>{t('retry')}</Button>
            </div>
          </>
        )}
      </Card>
    )
  }

  const view = status
  const lastOperation = view.lastOperation
  const lastOperationKey = lastOperation === null ? null : operationLabelKey(lastOperation.operation)
  const notConfigured = view.state === 'not-configured'

  return (
    <>
      {props.error === null ? null : (
        <Banner tone="error">
          {t('overviewLoadFailed', { message: props.error })}{' '}
          <LinkButton onClick={props.onRefreshStatus}>{t('retry')}</LinkButton>
        </Banner>
      )}

      {notConfigured ? (
        <Banner tone="idle">
          <span>{t('overviewNotConfiguredHint')}</span>
          <span className="dcs-btnRow">
            <Button small onClick={props.onGoConfig}>
              {t('overviewGoConfig')}
            </Button>
          </span>
        </Banner>
      ) : null}

      {view.state === 'error' && view.lastError !== null ? (
        <Banner tone="error">{view.lastError}</Banner>
      ) : null}

      {view.config.autoSync.enabled && view.autoSyncFailures > 0 ? (
        <Banner tone="warn">{t('overviewAutoSyncFailures', { count: view.autoSyncFailures })}</Banner>
      ) : null}

      {view.busy ? (
        <p className="dcs-loading" role="status" aria-live="polite">
          <span className="dcs-spinner" aria-hidden="true" />
          {t('overviewBusy')}
        </p>
      ) : null}

      <Card
        title={t('overviewTitle')}
        description={t('overviewDesc')}
        trailing={
          <div className="dcs-cardActions">
            <Button small onClick={props.onRefreshStatus} loading={props.refreshing}>
              {t('overviewRefresh')}
            </Button>
            <Button small onClick={props.onRefreshSections} loading={props.sectionsRefreshing}>
              {t('overviewRefreshSections')}
            </Button>
            <Button small variant="primary" onClick={props.onGoSync}>
              {t('overviewGoSync')}
            </Button>
          </div>
        }
      >
        <KeyValue
          items={[
            {
              label: t('headerState'),
              value: <Badge tone={stateTone(view.state)}>{t(stateLabelKey(view.state))}</Badge>,
            },
            {
              label: t('headerBackend'),
              value: (
                <span>
                  {t(backendLabelKey(view.config.backendKind))}
                  {' · '}
                  <span className="dcs-muted">
                    {formatBackendDestination(view.config) === ''
                      ? t('headerNotConfigured')
                      : formatBackendDestination(view.config)}
                  </span>
                </span>
              ),
              wrap: true,
            },
            { label: t('headerProfile'), value: view.config.activeProfile },
            { label: t('headerDevice'), value: view.config.device.name },
            { label: t('overviewLocalItems'), value: formatCount(view.localItemCount, t('notAvailable')) },
            {
              label: t('overviewRemoteItems'),
              value: formatCount(view.remoteItemCount, t('notAvailable')),
            },
            { label: t('overviewPendingUp'), value: formatCount(view.pendingUploads, t('notAvailable')) },
            {
              label: t('overviewPendingDown'),
              value: formatCount(view.pendingDownloads, t('notAvailable')),
            },
            {
              label: t('overviewConflicts'),
              value:
                view.conflictCount > 0 ? (
                  <Badge tone="warn">{formatCount(view.conflictCount, t('notAvailable'))}</Badge>
                ) : (
                  formatCount(view.conflictCount, t('notAvailable'))
                ),
            },
            { label: t('overviewLastSync'), value: formatDateTime(view.lastSyncAt, t('never')) },
            {
              label: t('overviewLastRevision'),
              value: (
                <span className="dcs-mono">{formatRevision(view.lastRevision, t('notAvailable'))}</span>
              ),
            },
            {
              label: t('overviewConnection'),
              value:
                view.connection === null ? (
                  <span className="dcs-muted">{t('overviewConnectionUnknown')}</span>
                ) : (
                  <span>
                    <Badge tone={view.connection.ok ? 'success' : 'error'}>
                      {view.connection.ok ? t('overviewConnectionOk') : t('overviewConnectionFail')}
                    </Badge>{' '}
                    <span className="dcs-small dcs-muted">
                      {t('overviewConnectionAt', {
                        time: formatDateTime(view.connection.at, t('notAvailable')),
                      })}
                    </span>
                  </span>
                ),
              wrap: true,
            },
            {
              label: t('overviewLastOperation'),
              value:
                lastOperation === null ? (
                  <span className="dcs-muted">{t('notAvailable')}</span>
                ) : (
                  <span>
                    {lastOperationKey === null ? lastOperation.operation : t(lastOperationKey)}
                    {' · '}
                    <span className="dcs-muted">
                      {formatDateTime(lastOperation.at, t('notAvailable'))}
                      {' · '}
                      {lastOperation.ok ? t('resultOk') : t('resultFailed')}
                    </span>
                  </span>
                ),
              wrap: true,
            },
            {
              label: t('overviewLastError'),
              value:
                view.lastError === null ? (
                  <span className="dcs-muted">{t('notAvailable')}</span>
                ) : (
                  <span>{view.lastError}</span>
                ),
              wrap: true,
            },
          ]}
        />
      </Card>

      <Card title={t('overviewSectionsTitle')} description={t('overviewSectionsDesc')}>
        {view.sections.length === 0 ? (
          <Empty text={t('overviewEmpty')} />
        ) : (
          <div className="dcs-sectionGrid">
            {view.sections.map(section => (
              <SectionCard key={section.section} t={t} section={section} />
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
