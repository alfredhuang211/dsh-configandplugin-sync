/**
 * Tests for the pure presentation helpers: dates, numbers, versions,
 * revisions, destinations, and dictionary-key lookups for Host enums.
 */

import { describe, expect, it } from 'vitest'
import {
  backendLabelKey,
  diffKindLabelKey,
  formatBackendDestination,
  formatCount,
  formatDateTime,
  formatFields,
  formatNumber,
  formatProfileList,
  formatRevision,
  formatVersion,
  levelTone,
  operationLabelKey,
  originLabelKey,
  planKindLabelKey,
  resultTone,
  sectionLabelKey,
  shortRevision,
  stateLabelKey,
  stateTone,
  transportLabelKey,
} from '../../client/src/format'
import { makeConfigView } from './fixtures'

describe('formatDateTime', () => {
  it('returns the fallback for missing or empty timestamps', () => {
    expect(formatDateTime(null, '—')).toBe('—')
    expect(formatDateTime(undefined, '—')).toBe('—')
    expect(formatDateTime('   ', '—')).toBe('—')
  })

  it('returns the raw value for an unparsable timestamp', () => {
    expect(formatDateTime('not-a-date', '—')).toBe('not-a-date')
  })

  it('formats a valid ISO timestamp with its year', () => {
    const text = formatDateTime('2026-03-04T05:06:07.000Z', '—')
    expect(text).not.toBe('—')
    expect(text).toContain('2026')
  })
})

describe('formatNumber and formatCount', () => {
  it('groups thousands deterministically', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(7)).toBe('7')
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(-1234)).toBe('-1,234')
    expect(formatNumber(1_234_567)).toBe('1,234,567')
  })

  it('degrades non-finite numbers to zero', () => {
    expect(formatNumber(Number.NaN)).toBe('0')
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('0')
  })

  it('falls back when a count is absent', () => {
    expect(formatCount(null, '—')).toBe('—')
    expect(formatCount(undefined, '—')).toBe('—')
    expect(formatCount(1234, '—')).toBe('1,234')
  })
})

describe('versions and revisions', () => {
  it('formats a version or its fallback', () => {
    expect(formatVersion(null, '—')).toBe('—')
    expect(formatVersion('  ', '—')).toBe('—')
    expect(formatVersion(' 1.2.3 ', '—')).toBe('1.2.3')
    expect(formatVersion('v1.2.3', '—')).toBe('v1.2.3')
  })

  it('shortens a revision to eight characters', () => {
    expect(shortRevision('abcdef1234567890')).toBe('abcdef12')
    expect(shortRevision(null)).toBe('')
    expect(shortRevision('  abcdef  ')).toBe('abcdef')
  })

  it('formats a revision or its fallback', () => {
    expect(formatRevision(null, '—')).toBe('—')
    expect(formatRevision('', '—')).toBe('—')
    expect(formatRevision('abcdef1234567890', '—')).toBe('abcdef12')
  })
})

describe('lists', () => {
  it('joins profiles, removing blanks and duplicates', () => {
    expect(formatProfileList([], '—')).toBe('—')
    expect(formatProfileList([' a ', 'b', 'a', '  '], '—')).toBe('a, b')
  })

  it('joins differing fields', () => {
    expect(formatFields([], '—')).toBe('—')
    expect(formatFields(['version', ' enabled '], '—')).toBe('version, enabled')
  })
})

describe('formatBackendDestination', () => {
  it('shows the Git repository URL', () => {
    expect(formatBackendDestination(makeConfigView())).toBe('https://example.com/store.git')
  })

  it('shows the WebDAV collection URL', () => {
    expect(formatBackendDestination(makeConfigView({ backendKind: 'webdav' }))).toBe('https://dav.example.com/dsh')
  })

  it('shows an s3://bucket/prefix destination', () => {
    expect(formatBackendDestination(makeConfigView({ backendKind: 's3' }))).toBe('s3://dsh-store/sync')
  })

  it('normalizes slashes in the S3 prefix', () => {
    const view = makeConfigView({
      backendKind: 's3',
      s3: { ...makeConfigView().s3, prefix: '/a/b/' },
    })
    expect(formatBackendDestination(view)).toBe('s3://dsh-store/a/b')
  })

  it('falls back to the S3 endpoint when no bucket is set', () => {
    const view = makeConfigView({ backendKind: 's3', s3: { ...makeConfigView().s3, bucket: '' } })
    expect(formatBackendDestination(view)).toBe('https://s3.example.com')
  })

  it('shows an empty destination when nothing is configured', () => {
    const view = makeConfigView({ git: { ...makeConfigView().git, repoUrl: '  ' } })
    expect(formatBackendDestination(view)).toBe('')
  })
})

describe('enum label keys', () => {
  it('maps backends, states, and sections', () => {
    expect(backendLabelKey('git')).toBe('backendGit')
    expect(backendLabelKey('webdav')).toBe('backendWebdav')
    expect(backendLabelKey('s3')).toBe('backendS3')
    expect(stateLabelKey('synced')).toBe('stateSynced')
    expect(stateLabelKey('conflict')).toBe('stateConflict')
    expect(sectionLabelKey('plugin-configs')).toBe('sectionPluginConfigs')
  })

  it('maps diff and plan action kinds', () => {
    expect(diffKindLabelKey('local-only')).toBe('diffLocalOnly')
    expect(diffKindLabelKey('deleted-remote')).toBe('diffDeletedRemote')
    expect(planKindLabelKey('push-secret')).toBe('planKindPushSecret')
    expect(planKindLabelKey('remove-remote-item')).toBe('planKindRemoveRemoteItem')
  })

  it('maps origins, transports, and operations, with a safe fallback', () => {
    expect(originLabelKey('local-path')).toBe('originLocalPath')
    expect(originLabelKey('something-new')).toBe('originUnknown')
    expect(transportLabelKey('streamable-http')).toBe('transportStreamableHttp')
    expect(transportLabelKey('something-new')).toBe('transportUnknown')
    expect(operationLabelKey('backup')).toBe('opBackup')
    expect(operationLabelKey('restore')).toBe('opRestore')
    expect(operationLabelKey('sync')).toBe('opSync')
    expect(operationLabelKey('rollback')).toBe('opRollback')
    expect(operationLabelKey('weird')).toBeNull()
    expect(operationLabelKey(null)).toBeNull()
  })
})

describe('tones', () => {
  it('tones a sync state', () => {
    expect(stateTone('synced')).toBe('success')
    expect(stateTone('error')).toBe('error')
    expect(stateTone('conflict')).toBe('warn')
    expect(stateTone('ahead')).toBe('warn')
    expect(stateTone('behind')).toBe('warn')
    expect(stateTone('diverged')).toBe('warn')
    expect(stateTone('not-configured')).toBe('idle')
    expect(stateTone('unknown')).toBe('idle')
  })

  it('tones a log level', () => {
    expect(levelTone('error')).toBe('error')
    expect(levelTone('warn')).toBe('warn')
    expect(levelTone('info')).toBe('idle')
    expect(levelTone('debug')).toBe('idle')
  })

  it('tones a history result', () => {
    expect(resultTone('ok')).toBe('success')
    expect(resultTone('SUCCEEDED')).toBe('success')
    expect(resultTone('failed')).toBe('error')
    expect(resultTone('')).toBe('idle')
    expect(resultTone(undefined)).toBe('idle')
    expect(resultTone('partial')).toBe('idle')
  })
})
