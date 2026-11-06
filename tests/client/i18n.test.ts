/// <reference types="node" />
/**
 * Tests for the copy layer: dictionary completeness, zh/en parity, placeholder
 * parity, the translator adapters, the locale JSON mirrors, and the guarantee
 * that every key the page asks for actually exists.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NS,
  createTranslate,
  en,
  fallbackTranslate,
  interpolate,
  zh,
} from '../../client/src/i18n'
import type { Translate } from '../../client/src/i18n'
import {
  backendLabelKey,
  diffKindLabelKey,
  installMethodLabelKey,
  levelTone,
  operationLabelKey,
  originLabelKey,
  planKindLabelKey,
  sectionLabelKey,
  stateLabelKey,
  stateTone,
  transportLabelKey,
} from '../../client/src/format'
import type { BackendKind, DiffKind, LogEntry, PlanActionKind, PluginOrigin, SectionId, SyncState } from '../../src/types.js'

const CLIENT_SRC = fileURLToPath(new URL('../../client/src/', import.meta.url))

/** Every `{placeholder}` name in a template, sorted. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
    .map(match => match[1] ?? '')
    .filter(name => name !== '')
    .sort()
}

/** All TypeScript sources under `client/src`, as absolute paths. */
function sourceFiles(): string[] {
  return readdirSync(CLIENT_SRC, { recursive: true })
    .map(entry => String(entry))
    .filter(entry => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map(entry => join(CLIENT_SRC, entry))
}

/**
 * Keys the page asks for with a literal argument: `t('key')`, `t("key")`, or a
 * `labelKey: 'key'` table entry.
 */
function referencedKeys(): string[] {
  const keys = new Set<string>()
  const patterns = [/\bt\(\s*'([A-Za-z0-9_]+)'/g, /\bt\(\s*"([A-Za-z0-9_]+)"/g, /labelKey:\s*'([A-Za-z0-9_]+)'/g]
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (match[1] !== undefined) keys.add(match[1])
      }
    }
  }
  return [...keys].sort()
}

/** Parse one locale JSON file as a string dictionary. */
function readLocale(name: 'zh' | 'en'): Record<string, string> {
  const path = fileURLToPath(new URL(`../../locale/${name}.json`, import.meta.url))
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return parsed as Record<string, string>
}

describe('dictionaries', () => {
  it('defines the same key set in zh and en', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has no empty or key-shaped values', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh.${key}`).not.toBe('')
      expect(value, `zh.${key}`).not.toBe(key)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en.${key}`).not.toBe('')
      expect(value, `en.${key}`).not.toBe(key)
    }
  })

  it('uses the same placeholders in both languages', () => {
    for (const key of Object.keys(zh)) {
      expect(placeholders(zh[key] ?? ''), `placeholders of ${key}`).toEqual(placeholders(en[key] ?? ''))
    }
  })

  it('mirrors the dictionaries in locale/zh.json and locale/en.json', () => {
    expect(readLocale('zh')).toEqual(zh)
    expect(readLocale('en')).toEqual(en)
  })

  it('uses the package name as the locale namespace', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { name: string }
    expect(NS).toBe(pkg.name)
  })
})

describe('key coverage', () => {
  it('defines every key the page references literally', () => {
    const keys = referencedKeys()
    expect(keys.length).toBeGreaterThan(100)
    const missing = keys.filter(key => zh[key] === undefined)
    expect(missing).toEqual([])
  })

  it('defines every key produced by the enum label helpers', () => {
    const keys: string[] = []
    const backends: BackendKind[] = ['git', 'webdav', 's3']
    const states: SyncState[] = [
      'not-configured',
      'synced',
      'ahead',
      'behind',
      'diverged',
      'conflict',
      'error',
      'syncing',
      'unknown',
    ]
    const kinds: PlanActionKind[] = [
      'install-plugin',
      'upgrade-plugin',
      'downgrade-plugin',
      'enable-plugin',
      'disable-plugin',
      'remove-plugin',
      'write-plugin-config',
      'write-provider',
      'write-dsh-config',
      'write-mcp',
      'write-secret',
      'push-plugin',
      'push-plugin-config',
      'push-provider',
      'push-dsh-config',
      'push-mcp',
      'push-secret',
      'remove-remote-item',
    ]
    const diffs: DiffKind[] = [
      'identical',
      'local-only',
      'remote-only',
      'changed',
      'deleted-remote',
      'deleted-local',
      'unsupported',
    ]
    const origins: PluginOrigin[] = ['npm', 'git', 'local-path', 'tarball', 'official', 'unknown']
    const sections: SectionId[] = ['dsh-config', 'providers', 'plugins', 'plugin-configs', 'secrets', 'mcp']
    const levels: LogEntry['level'][] = ['debug', 'info', 'warn', 'error']

    for (const kind of backends) keys.push(backendLabelKey(kind))
    for (const state of states) keys.push(stateLabelKey(state))
    for (const kind of kinds) keys.push(planKindLabelKey(kind))
    for (const kind of diffs) keys.push(diffKindLabelKey(kind))
    for (const origin of origins) keys.push(originLabelKey(origin))
    for (const section of sections) keys.push(sectionLabelKey(section))
    for (const transport of ['stdio', 'streamable-http', 'sse', 'unknown']) keys.push(transportLabelKey(transport))
    for (const method of ['npx', 'uvx', 'pip', 'npm', 'binary', 'http', 'docker', 'unknown']) {
      keys.push(installMethodLabelKey(method))
    }
    for (const operation of ['backup', 'restore', 'sync', 'rollback']) {
      const key = operationLabelKey(operation)
      expect(key).not.toBeNull()
      keys.push(key as string)
    }
    for (const level of levels) {
      expect(['idle', 'success', 'warn', 'error']).toContain(levelTone(level))
    }

    expect(keys.filter(key => zh[key] === undefined)).toEqual([])
    expect(keys.filter(key => en[key] === undefined)).toEqual([])
  })
})

describe('interpolate', () => {
  it('replaces every occurrence of a placeholder', () => {
    expect(interpolate('{a} and {b} and {a}', { a: 1, b: 'two' })).toBe('1 and two and 1')
  })

  it('leaves unknown placeholders alone', () => {
    expect(interpolate('keep {unknown}', { known: 'x' })).toBe('keep {unknown}')
  })

  it('returns the template untouched when no values are given', () => {
    expect(interpolate('no values')).toBe('no values')
  })
})

describe('createTranslate', () => {
  it('passes a Host translation through and interpolates it', () => {
    const translate = createTranslate(key => `host:${key}`)
    expect(translate('nav')).toBe('host:nav')
    expect(translate('planSummaryTotal', { n: 3 })).toBe('host:planSummaryTotal')
  })

  it('falls back to the key when the Host returns an empty string', () => {
    const translate = createTranslate(() => '')
    expect(translate('nav')).toBe('nav')
  })

  it('falls back to a bundled dictionary when the Host translator throws', () => {
    const translate = createTranslate(() => {
      throw new Error('locale service moved')
    })
    const value = translate('nav')
    expect(value === zh.nav || value === en.nav).toBe(true)
  })

  it('interpolates placeholders the Host left in place', () => {
    const translate = createTranslate(key => zh[key] ?? key)
    expect(translate('planSummaryTotal', { n: 4 })).toBe('共 4 步')
  })
})

describe('fallbackTranslate', () => {
  it('returns dictionary text, not a bare key', () => {
    const translate: Translate = fallbackTranslate()
    const value = translate('syncPreview')
    expect(value).not.toBe('syncPreview')
    expect(value === zh.syncPreview || value === en.syncPreview).toBe(true)
  })
})
