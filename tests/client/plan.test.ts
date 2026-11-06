/**
 * Tests for the pure plan logic the Sync tab and confirmation dialog rely on:
 * summaries, destructive detection, conflict accounting, and grouped actions.
 */

import { describe, expect, it } from 'vitest'
import {
  conflictKey,
  conflictKeys,
  conflictResolutions,
  destructiveActions,
  groupPlanActions,
  initialConflictChoices,
  missingConflictCount,
  notableDiffs,
  planNeedsConfirmation,
  summarizePlan,
} from '../../client/src/plan'
import { makeAction, makeConflict, makePlan } from './fixtures'

describe('conflict identity', () => {
  it('keys a conflict by section and id', () => {
    expect(conflictKey(makeConflict())).toBe('plugins:pkg-a')
    expect(conflictKey(makeConflict({ section: 'mcp', id: 'server-1' }))).toBe('mcp:server-1')
  })

  it('lists every conflict key in plan order', () => {
    const plan = makePlan({
      conflicts: [
        makeConflict(),
        makeConflict({ section: 'mcp', id: 'server-1' }),
        makeConflict({ section: 'secrets', id: 'DEEPSEEK_API_KEY' }),
      ],
    })
    expect(conflictKeys(plan)).toEqual([
      'plugins:pkg-a',
      'mcp:server-1',
      'secrets:DEEPSEEK_API_KEY',
    ])
  })

  it('starts with no choices so the user must decide explicitly', () => {
    expect(initialConflictChoices()).toEqual({})
  })
})

describe('summarizePlan', () => {
  it('summarizes an empty plan', () => {
    const summary = summarizePlan(makePlan())
    expect(summary).toEqual({
      total: 0,
      destructive: 0,
      conflicts: 0,
      unresolved: 0,
      warnings: 0,
      diffs: 0,
      requiresConfirmation: false,
      hasChanges: false,
      bySection: [],
      conflictKeys: [],
    })
  })

  it('counts actions, destructive steps, conflicts, warnings, and differences', () => {
    const plan = makePlan({
      actions: [
        makeAction({ kind: 'install-plugin', section: 'plugins', id: 'pkg-b' }),
        makeAction({ kind: 'remove-plugin', section: 'plugins', id: 'pkg-c', destructive: true }),
        makeAction({ kind: 'write-provider', section: 'providers', id: 'openai' }),
      ],
      conflicts: [makeConflict(), makeConflict({ section: 'mcp', id: 'server-1' })],
      warnings: ['missing passphrase'],
      diffs: [
        {
          section: 'plugins',
          id: 'pkg-d',
          name: 'pkg-d',
          kind: 'remote-only',
          fields: [],
          destructive: false,
        },
      ],
      requiresConfirmation: true,
    })

    const summary = summarizePlan(plan)
    expect(summary.total).toBe(3)
    expect(summary.destructive).toBe(1)
    expect(summary.conflicts).toBe(2)
    expect(summary.unresolved).toBe(2)
    expect(summary.warnings).toBe(1)
    expect(summary.diffs).toBe(1)
    expect(summary.requiresConfirmation).toBe(true)
    expect(summary.hasChanges).toBe(true)
    expect(summary.bySection).toEqual([
      { section: 'plugins', count: 2 },
      { section: 'providers', count: 1 },
    ])
    expect(summary.conflictKeys).toEqual(['plugins:pkg-a', 'mcp:server-1'])
  })

  it('treats conflicts alone as a change worth previewing', () => {
    const summary = summarizePlan(makePlan({ conflicts: [makeConflict()] }))
    expect(summary.hasChanges).toBe(true)
    expect(summary.total).toBe(0)
  })

  it('counts unresolved conflicts against the current choices', () => {
    const first = makeConflict()
    const second = makeConflict({ section: 'mcp', id: 'server-1' })
    const plan = makePlan({ conflicts: [first, second] })
    const partial = { [conflictKey(first)]: 'local' as const }
    expect(summarizePlan(plan, partial).unresolved).toBe(1)
    const complete = { ...partial, [conflictKey(second)]: 'skip' as const }
    expect(summarizePlan(plan, complete).unresolved).toBe(0)
  })
})

describe('confirmation needs', () => {
  it('needs confirmation for a destructive step even when the Host says no', () => {
    const plan = makePlan({ actions: [makeAction({ destructive: true })] })
    expect(planNeedsConfirmation(plan)).toBe(true)
  })

  it('needs confirmation when the Host flags the plan', () => {
    expect(planNeedsConfirmation(makePlan({ requiresConfirmation: true }))).toBe(true)
  })

  it('does not need confirmation for a clean plan', () => {
    expect(planNeedsConfirmation(makePlan({ actions: [makeAction()] }))).toBe(false)
  })

  it('lists destructive actions only', () => {
    const plan = makePlan({
      actions: [
        makeAction({ id: 'a' }),
        makeAction({ id: 'b', destructive: true }),
        makeAction({ id: 'c', destructive: true }),
      ],
    })
    expect(destructiveActions(plan).map(action => action.id)).toEqual(['b', 'c'])
  })
})

describe('conflict choices', () => {
  const first = makeConflict()
  const second = makeConflict({ section: 'mcp', id: 'server-1' })
  const plan = makePlan({ conflicts: [first, second] })

  it('counts conflicts without a choice', () => {
    expect(missingConflictCount(plan, {})).toBe(2)
    expect(missingConflictCount(plan, { [conflictKey(first)]: 'local' })).toBe(1)
  })

  it('returns undefined resolutions when the plan has no conflicts', () => {
    expect(conflictResolutions(makePlan(), {})).toBeUndefined()
  })

  it('maps only chosen conflicts, keeping section and id', () => {
    const choices = { [conflictKey(first)]: 'remote' as const }
    expect(conflictResolutions(plan, choices)).toEqual([
      { section: 'plugins', id: 'pkg-a', choice: 'remote' },
    ])
  })

  it('includes a deliberate skip', () => {
    const choices = {
      [conflictKey(first)]: 'skip' as const,
      [conflictKey(second)]: 'local' as const,
    }
    expect(conflictResolutions(plan, choices)).toEqual([
      { section: 'plugins', id: 'pkg-a', choice: 'skip' },
      { section: 'mcp', id: 'server-1', choice: 'local' },
    ])
  })
})

describe('groupPlanActions', () => {
  it('groups actions by section in first-appearance order', () => {
    const plan = makePlan({
      actions: [
        makeAction({ section: 'providers', id: 'a' }),
        makeAction({ section: 'plugins', id: 'b' }),
        makeAction({ section: 'providers', id: 'c' }),
      ],
    })
    expect(groupPlanActions(plan).map(group => [group.section, group.actions.map(action => action.id)])).toEqual([
      ['providers', ['a', 'c']],
      ['plugins', ['b']],
    ])
  })

  it('returns no groups for a plan without actions', () => {
    expect(groupPlanActions(makePlan())).toEqual([])
  })

  it('exposes the plan differences unchanged', () => {
    const plan = makePlan({
      diffs: [
        {
          section: 'secrets',
          id: 'ref',
          name: 'ref',
          kind: 'changed',
          fields: ['source'],
          destructive: false,
        },
      ],
    })
    expect(notableDiffs(plan)).toBe(plan.diffs)
  })
})
