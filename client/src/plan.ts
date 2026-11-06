/**
 * Pure plan helpers: how a tab reads a Host `SyncPlan`.
 *
 * The Host refuses to run a plan that has unresolved conflicts or destructive
 * steps; the page therefore has to answer three questions before it may run
 * anything: what will happen, what is destructive, and which conflicts still
 * need a decision. All three answers are computed here, DOM-free, so the
 * components only render the result.
 * @module plan
 */

import type {
  ConflictChoice,
  ConflictInfo,
  ConflictResolution,
  ItemDiff,
  PlanAction,
  SectionId,
  SyncPlan,
} from '../../src/types.js'

/** Actions of one section, in plan order. */
export interface PlanSectionGroup {
  section: SectionId
  actions: PlanAction[]
}

/** One section's action count, used by the summary strip. */
export interface PlanSectionCount {
  section: SectionId
  count: number
}

/** Everything the Sync tab and the confirmation dialog show about a plan. */
export interface PlanSummary {
  /** Number of executable steps. */
  total: number
  /** Steps that delete or overwrite content. */
  destructive: number
  /** Conflicts the Host reported. */
  conflicts: number
  /** Conflicts with no explicit choice yet. */
  unresolved: number
  /** Host warnings. */
  warnings: number
  /** Differences found but not actionable. */
  diffs: number
  /** A destructive step or an explicit Host confirmation flag is present. */
  requiresConfirmation: boolean
  /** Whether the plan changes anything at all. */
  hasChanges: boolean
  /** Action counts per section, in first-appearance order. */
  bySection: PlanSectionCount[]
  /** Stable keys of every conflict, matching {@link conflictKey}. */
  conflictKeys: string[]
}

/** Stable identity of one conflict: section plus item id. */
export function conflictKey(conflict: Pick<ConflictInfo, 'section' | 'id'>): string {
  return `${conflict.section}:${conflict.id}`
}

/** Stable identities of every conflict in a plan, in plan order. */
export function conflictKeys(plan: SyncPlan): string[] {
  return plan.conflicts.map(conflict => conflictKey(conflict))
}

/**
 * A fresh choice map: deliberately empty, so the user has to pick one side or
 * "skip" for every conflict instead of confirming a default by accident.
 */
export function initialConflictChoices(): Record<string, ConflictChoice> {
  return {}
}

/** Whether the plan contains any destructive step. */
export function hasDestructiveAction(plan: SyncPlan): boolean {
  return plan.actions.some(action => action.destructive)
}

/** Destructive steps of a plan, in plan order. */
export function destructiveActions(plan: SyncPlan): PlanAction[] {
  return plan.actions.filter(action => action.destructive)
}

/** A destructive step or an explicit Host confirmation flag needs a dialog. */
export function planNeedsConfirmation(plan: SyncPlan): boolean {
  return plan.requiresConfirmation || hasDestructiveAction(plan)
}

/** Group plan actions by section, preserving first-appearance order. */
export function groupPlanActions(plan: SyncPlan): PlanSectionGroup[] {
  const groups: PlanSectionGroup[] = []
  for (const action of plan.actions) {
    const existing = groups.find(group => group.section === action.section)
    if (existing === undefined) groups.push({ section: action.section, actions: [action] })
    else existing.actions.push(action)
  }
  return groups
}

/** How many conflicts still have no explicit choice. */
export function missingConflictCount(plan: SyncPlan, choices: Record<string, ConflictChoice>): number {
  let missing = 0
  for (const conflict of plan.conflicts) {
    if (choices[conflictKey(conflict)] === undefined) missing += 1
  }
  return missing
}

/**
 * The `resolutions` array a mutating request needs.
 *
 * Returns `undefined` when the plan has no conflicts (the request then carries
 * no `resolutions` at all) and otherwise one entry per *chosen* conflict. A
 * conflict without a choice is omitted, so the Host re-reports it as
 * `conflict-present` instead of silently skipping it.
 */
export function conflictResolutions(
  plan: SyncPlan,
  choices: Record<string, ConflictChoice>,
): ConflictResolution[] | undefined {
  if (plan.conflicts.length === 0) return undefined
  const resolutions: ConflictResolution[] = []
  for (const conflict of plan.conflicts) {
    const choice = choices[conflictKey(conflict)]
    if (choice === undefined) continue
    resolutions.push({ section: conflict.section, id: conflict.id, choice })
  }
  return resolutions
}

/** Differences that need no decision, grouped for a compact list. */
export function notableDiffs(plan: SyncPlan): ItemDiff[] {
  return plan.diffs
}

/** Compute the summary the Sync tab renders. */
export function summarizePlan(plan: SyncPlan, choices: Record<string, ConflictChoice> = {}): PlanSummary {
  const groups = groupPlanActions(plan)
  return {
    total: plan.actions.length,
    destructive: plan.actions.filter(action => action.destructive).length,
    conflicts: plan.conflicts.length,
    unresolved: missingConflictCount(plan, choices),
    warnings: plan.warnings.length,
    diffs: plan.diffs.length,
    requiresConfirmation: planNeedsConfirmation(plan),
    hasChanges: plan.actions.length > 0 || plan.conflicts.length > 0,
    bySection: groups.map(group => ({ section: group.section, count: group.actions.length })),
    conflictKeys: conflictKeys(plan),
  }
}
