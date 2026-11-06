/**
 * Rendering of a Host `SyncPlan`: what an operation would do, and — for every
 * conflict — the three legal decisions with the consequence of each.
 *
 * The preview is read-first: summary strip, conflicts (the only part that needs
 * a decision), destructive steps, remaining steps, warnings, then differences
 * that need no action. Components stay presentational; every count comes from
 * `summarizePlan`, so the dialog and the tab can never disagree.
 * @module ui/PlanPreview
 */

import type { ReactElement } from 'react'
import type { ConflictChoice, ConflictInfo, ItemDiff, PlanAction, SyncPlan } from '../../../src/types.js'
import type { Translate } from '../i18n'
import { diffKindLabelKey, planKindLabelKey, sectionLabelKey } from '../format'
import { conflictKey, summarizePlan } from '../plan'
import type { PlanSummary } from '../plan'
import { Badge } from './controls'

/** Friendly, localized text for a conflict reason. */
export function conflictReasonText(t: Translate, conflict: ConflictInfo): string {
  switch (conflict.reason) {
    case 'both-changed':
      return t('conflictReasonBothChanged')
    case 'local-deleted':
      return t('conflictReasonLocalDeleted')
    case 'remote-deleted':
      return t('conflictReasonRemoteDeleted')
    case 'both-added':
      return t('conflictReasonBothAdded')
    default: {
      const raw = conflict.reason.trim()
      return raw === '' ? t('conflictReasonGeneric') : raw
    }
  }
}

/** Consequence line for one choice. */
function effectText(t: Translate, choice: ConflictChoice): string {
  switch (choice) {
    case 'local':
      return t('conflictEffectLocal')
    case 'remote':
      return t('conflictEffectRemote')
    case 'skip':
    default:
      return t('conflictEffectSkip')
  }
}

/** One plan row: item name, step kind, optional detail. */
function ActionRow(props: { t: Translate; action: PlanAction }): ReactElement {
  const { t, action } = props
  return (
    <li className={action.destructive ? 'dcs-planItem dcs-planItemDestructive' : 'dcs-planItem'}>
      <div className="dcs-planItemHead">
        <span className="dcs-planName">{action.name}</span>
        <span className="dcs-planKind">{t(planKindLabelKey(action.kind))}</span>
        {action.destructive ? <Badge tone="error">{t('planDestructiveBadge')}</Badge> : null}
      </div>
      {action.detail === '' ? null : <span className="dcs-planDetail">{action.detail}</span>}
    </li>
  )
}

/** One difference found but not actionable in this direction. */
function DiffRow(props: { t: Translate; diff: ItemDiff }): ReactElement {
  const { t, diff } = props
  return (
    <li className="dcs-planItem">
      <div className="dcs-planItemHead">
        <span className="dcs-planName">{diff.name}</span>
        <span className="dcs-planKind">{t(diffKindLabelKey(diff.kind))}</span>
        <span className="dcs-planKind">{t(sectionLabelKey(diff.section))}</span>
        {diff.destructive ? <Badge tone="error">{t('planDiffDestructive')}</Badge> : null}
      </div>
      {diff.fields.length === 0 ? null : (
        <span className="dcs-planDetail">{t('planDiffFields', { fields: diff.fields.join(', ') })}</span>
      )}
    </li>
  )
}

/** One conflict: localized reason, affected fields, and the three choices. */
function ConflictCard(props: {
  t: Translate
  conflict: ConflictInfo
  choice: ConflictChoice | undefined
  editable: boolean
  onChoice?: (conflict: ConflictInfo, choice: ConflictChoice) => void
}): ReactElement {
  const { t, conflict } = props
  const choices: ConflictChoice[] = ['local', 'remote', 'skip']
  const labels: Record<ConflictChoice, string> = {
    local: t('conflictChoiceLocal'),
    remote: t('conflictChoiceRemote'),
    skip: t('conflictChoiceSkip'),
  }
  return (
    <li className="dcs-conflictCard">
      <div className="dcs-conflictHead">
        <span className="dcs-planName">{conflict.name}</span>
        <span className="dcs-conflictMeta">
          {t(sectionLabelKey(conflict.section))}
          {conflict.remoteDevice === undefined || conflict.remoteDevice === ''
            ? ''
            : ` · ${t('conflictRemoteDevice', { device: conflict.remoteDevice })}`}
          {conflict.remoteUpdatedAt === undefined || conflict.remoteUpdatedAt === ''
            ? ''
            : ` · ${t('conflictRemoteUpdatedAt', { time: conflict.remoteUpdatedAt })}`}
        </span>
      </div>
      <p className="dcs-conflictReason">{conflictReasonText(t, conflict)}</p>
      {conflict.fields.length === 0 ? null : (
        <div className="dcs-conflictFields">
          {conflict.fields.map(field => (
            <span key={field} className="dcs-conflictField">
              {field}
            </span>
          ))}
        </div>
      )}
      {props.editable ? (
        <>
          <div className="dcs-choiceGroup" role="radiogroup" aria-label={t('conflictChoiceLabel')}>
            {choices.map(choice => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={props.choice === choice}
                className={
                  props.choice === choice ? 'dcs-choice dcs-choiceActive' : 'dcs-choice'
                }
                onClick={() => {
                  props.onChoice?.(conflict, choice)
                }}
              >
                {labels[choice]}
              </button>
            ))}
          </div>
          <p className="dcs-choiceEffect" aria-live="polite">
            {effectText(t, props.choice ?? 'skip')}
          </p>
        </>
      ) : (
        <p className="dcs-choiceEffect">{effectText(t, props.choice ?? 'skip')}</p>
      )}
    </li>
  )
}

/** Props for {@link PlanPreview}. */
export interface PlanPreviewProps {
  t: Translate
  plan: SyncPlan
  /** Current per-conflict choice, keyed by {@link conflictKey}. */
  choices: Record<string, ConflictChoice>
  editable?: boolean
  onChoice?: (conflict: ConflictInfo, choice: ConflictChoice) => void
  /** Override the computed summary (the confirmation dialog reuses the tab's). */
  summary?: PlanSummary
}

/** Render a plan: summary, conflicts, destructive steps, steps, warnings, diffs. */
export function PlanPreview(props: PlanPreviewProps): ReactElement {
  const { t, plan } = props
  const summary = props.summary ?? summarizePlan(plan, props.choices)
  const editable = props.editable !== false
  const destructive = plan.actions.filter(action => action.destructive)
  const others = plan.actions.filter(action => !action.destructive)

  return (
    <div className="dcs-plan">
      {plan.actions.length === 0 && plan.conflicts.length === 0 && plan.warnings.length === 0 ? (
        <p className="dcs-empty">{t('planEmpty')}</p>
      ) : null}

      <div className="dcs-planSummary">
        <span className="dcs-planSummaryItem">{t('planSummaryTotal', { n: summary.total })}</span>
        {summary.destructive === 0 ? null : (
          <span className="dcs-planSummaryItem dcs-planSummaryItemError">
            {t('planSummaryDestructive', { n: summary.destructive })}
          </span>
        )}
        {summary.conflicts === 0 ? null : (
          <span className="dcs-planSummaryItem dcs-planSummaryItemWarn">
            {t('planSummaryConflicts', { n: summary.conflicts })}
          </span>
        )}
        {summary.warnings === 0 ? null : (
          <span className="dcs-planSummaryItem">{t('planSummaryWarnings', { n: summary.warnings })}</span>
        )}
        {summary.diffs === 0 ? null : (
          <span className="dcs-planSummaryItem">{t('planSummaryDiffs', { n: summary.diffs })}</span>
        )}
      </div>

      {plan.conflicts.length === 0 ? null : (
        <section className="dcs-planSection dcs-conflictSection">
          <h4 className="dcs-planHeading">{t('planConflictsTitle', { count: plan.conflicts.length })}</h4>
          {editable ? (
            <p className={summary.unresolved === 0 ? 'dcs-hint' : 'dcs-hint dcs-hintWarn'}>
              {summary.unresolved === 0
                ? t('syncConflictAllChosen')
                : t('syncConflictMissing', { count: summary.unresolved })}
            </p>
          ) : null}
          <ul className="dcs-conflictList">
            {plan.conflicts.map(conflict => (
              <ConflictCard
                key={conflictKey(conflict)}
                t={t}
                conflict={conflict}
                choice={props.choices[conflictKey(conflict)]}
                editable={editable}
                {...(props.onChoice === undefined ? {} : { onChoice: props.onChoice })}
              />
            ))}
          </ul>
        </section>
      )}

      {destructive.length === 0 ? null : (
        <section className="dcs-planSection">
          <h4 className="dcs-planHeading">{t('planDestructiveTitle', { count: destructive.length })}</h4>
          <ul className="dcs-planList">
            {destructive.map(action => (
              <ActionRow key={`destructive:${action.section}:${action.kind}:${action.id}`} t={t} action={action} />
            ))}
          </ul>
        </section>
      )}

      {others.length === 0 ? null : (
        <section className="dcs-planSection">
          <h4 className="dcs-planHeading">{t('planActionsTitle', { count: others.length })}</h4>
          <ul className="dcs-planList">
            {others.map(action => (
              <ActionRow key={`action:${action.section}:${action.kind}:${action.id}`} t={t} action={action} />
            ))}
          </ul>
        </section>
      )}

      {plan.warnings.length === 0 ? null : (
        <section className="dcs-planSection">
          <h4 className="dcs-planHeading">{t('planWarningsTitle', { count: plan.warnings.length })}</h4>
          <ul className="dcs-plainList">
            {plan.warnings.map((warning, index) => (
              <li key={`warning:${index}`}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      {plan.diffs.length === 0 ? null : (
        <section className="dcs-planSection">
          <h4 className="dcs-planHeading">{t('planDiffsTitle', { count: plan.diffs.length })}</h4>
          <ul className="dcs-planList">
            {plan.diffs.map(diff => (
              <DiffRow key={`diff:${diff.section}:${diff.id}`} t={t} diff={diff} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
