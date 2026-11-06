/**
 * Sync tab: preview a plan, decide every conflict, then confirm and run.
 *
 * The tab never runs a mutation itself. "Confirm and run" asks `Page` to open
 * the confirmation dialog, which shows the same plan again (including the
 * destructive steps) and only then calls the Host. Nothing destructive can run
 * from a single click.
 * @module ui/SyncTab
 */

import type { ReactElement } from 'react'
import type { ConflictChoice, ConflictInfo, SyncPlan } from '../../../src/types.js'
import type { Translate } from '../i18n'
import { formatCount, formatDateTime, formatRevision } from '../format'
import { summarizePlan } from '../plan'
import { Banner, Button, Card, Loading, Segmented } from './controls'
import { PlanPreview } from './PlanPreview'

/** Operation directions this page offers. */
export type SyncDirection = 'push' | 'pull' | 'two-way'

/** Props for {@link SyncTab}. */
export interface SyncTabProps {
  t: Translate
  configured: boolean
  direction: SyncDirection
  onDirectionChange: (direction: SyncDirection) => void
  onPreview: () => void
  previewing: boolean
  plan: SyncPlan | null
  revision: string | null
  planError: string | null
  choices: Record<string, ConflictChoice>
  onChoice: (conflict: ConflictInfo, choice: ConflictChoice) => void
  onRun: () => void
  running: boolean
  onGoConfig: () => void
}

/** Render the sync tab. */
export function SyncTab(props: SyncTabProps): ReactElement {
  const { t } = props
  const summary = props.plan === null ? null : summarizePlan(props.plan, props.choices)
  const conflictsBlocked = props.direction === 'push' && summary !== null && summary.conflicts > 0
  const unresolved = summary === null ? 0 : summary.unresolved
  const canRun =
    props.plan !== null &&
    !props.running &&
    !props.previewing &&
    unresolved === 0 &&
    !conflictsBlocked &&
    props.configured

  function directionHint(): string {
    switch (props.direction) {
      case 'push':
        return t('directionHintPush')
      case 'pull':
        return t('directionHintPull')
      case 'two-way':
      default:
        return t('directionHintTwoWay')
    }
  }

  return (
    <Card title={t('syncTitle')} description={t('syncDesc')}>
      <div className="dcs-field">
        <span className="dcs-label">{t('syncDirection')}</span>
        <Segmented<SyncDirection>
          label={t('syncDirection')}
          value={props.direction}
          disabled={props.running || props.previewing}
          options={[
            { value: 'push', label: t('directionPush'), title: t('directionHintPush') },
            { value: 'pull', label: t('directionPull'), title: t('directionHintPull') },
            { value: 'two-way', label: t('directionTwoWay'), title: t('directionHintTwoWay') },
          ]}
          onChange={props.onDirectionChange}
        />
        <span className="dcs-hint">{directionHint()}</span>
      </div>

      <div className="dcs-btnRow">
        <Button
          variant="primary"
          onClick={props.onPreview}
          disabled={!props.configured || props.previewing || props.running}
          loading={props.previewing}
        >
          {props.previewing ? t('syncPreviewing') : t('syncPreview')}
        </Button>
        {props.plan === null || props.planError === null ? null : (
          <Button onClick={props.onPreview} disabled={props.previewing || props.running}>
            {t('syncRefreshPlan')}
          </Button>
        )}
      </div>

      {!props.configured ? (
        <Banner tone="idle">
          <span>{t('overviewNotConfiguredHint')}</span>
          <span className="dcs-btnRow">
            <Button small onClick={props.onGoConfig}>
              {t('overviewGoConfig')}
            </Button>
          </span>
        </Banner>
      ) : null}

      {props.planError === null ? null : (
        <Banner tone="error">{t('syncPreviewFailed', { message: props.planError })}</Banner>
      )}

      {props.previewing ? <Loading text={t('syncPreviewing')} /> : null}

      {props.plan === null ? (
        props.previewing || props.planError !== null ? null : (
          <p className="dcs-empty">{t('syncNeedsPreview')}</p>
        )
      ) : (
        <>
          <div className="dcs-planSection">
            <h4 className="dcs-planHeading">{t('syncPlanTitle')}</h4>
            <div className="dcs-planSummary">
              <span className="dcs-planSummaryItem">
                {t('syncPlanProfile', { profile: props.plan.profile })}
              </span>
              <span className="dcs-planSummaryItem">
                {t('syncPlanCounts', {
                  local: formatCount(props.plan.localItemCount, t('notAvailable')),
                  remote: formatCount(props.plan.remoteItemCount, t('notAvailable')),
                })}
              </span>
              {props.revision === null ? null : (
                <span className="dcs-planSummaryItem dcs-mono">
                  {t('syncPlanRevision', { revision: formatRevision(props.revision, t('notAvailable')) })}
                </span>
              )}
              <span className="dcs-planSummaryItem">
                {t('syncPlanGeneratedAt', { time: formatDateTime(props.plan.generatedAt, t('notAvailable')) })}
              </span>
            </div>
            {summary !== null && summary.requiresConfirmation ? (
              <p className="dcs-hint dcs-hintWarn">{t('planRequiresConfirm')}</p>
            ) : null}
          </div>

          <PlanPreview
            t={t}
            plan={props.plan}
            choices={props.choices}
            summary={summary ?? undefined}
            onChoice={props.onChoice}
          />

          {conflictsBlocked ? <Banner tone="warn">{t('syncPushConflictBlocked')}</Banner> : null}

          {props.plan.conflicts.length === 0 ? null : (
            <p className={unresolved === 0 ? 'dcs-hint' : 'dcs-hint dcs-hintWarn'}>
              {unresolved === 0
                ? t('syncConflictAllChosen')
                : t('syncConflictMissing', { count: unresolved })}
            </p>
          )}

          <div className="dcs-btnRow">
            <Button
              variant={summary !== null && summary.requiresConfirmation ? 'danger' : 'primary'}
              onClick={props.onRun}
              disabled={!canRun}
              loading={props.running}
              title={canRun ? undefined : t('syncConflictPrompt')}
            >
              {props.running ? t('syncRunning') : t('syncRun')}
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}
