/**
 * Restoring another device's patch must not import a plugin that only exists
 * there.
 *
 * A `file://` Loader entry points at an absolute local path. Such entries are
 * common in a home patch (an observability sidecar, a locally built plugin), and
 * copying one into another device's patch would make the Loader import a file
 * that is not present — while also leaking the path into that device's config.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findMachineLocalEntryIds,
  isMachineLocalSpec,
  mergePackageText,
  mergePatchText,
  scanPatchEntryNames,
} from '../../src/engine/apply.js'
import { makeConfigFile } from '../helpers/snapshot.js'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

const LOCAL = `# my home patch
- id: local-only
  name: some-local-plugin
  config:
    keep: true
`

function remotePatch(fileEntryName: string): string {
  return `# BEGIN PILOT-OBSERVABILITY-MANAGED (created-file: true)
- insert:
  - id: 'onesuite-pilot-observability'
    name: ${fileEntryName}
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      tflow:
        api: openai-completions
`
}

describe('scanPatchEntryNames', () => {
  it('reads overrides and the rows nested in an insert block', () => {
    const names = scanPatchEntryNames(remotePatch("'file:///nonexistent/plugin.mjs'"))
    expect(names).toEqual([
      { id: 'onesuite-pilot-observability', name: 'file:///nonexistent/plugin.mjs' },
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
    ])
  })
})

describe('findMachineLocalEntryIds', () => {
  it('reports a file:// entry whose target is missing', async () => {
    const missing = await findMachineLocalEntryIds(remotePatch('file:///definitely/not/here/plugin.mjs'))
    expect(missing.map(entry => entry.id)).toEqual(['onesuite-pilot-observability'])
  })

  it('keeps a file:// entry whose target exists on this device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apply-merge-'))
    roots.push(root)
    const target = join(root, 'plugin.mjs')
    await writeFile(target, 'export default function apply() {}\n', 'utf8')
    const missing = await findMachineLocalEntryIds(remotePatch(`'file://${target}'`))
    expect(missing).toEqual([])
  })

  it('does not treat a registry or git entry as machine-local', async () => {
    const missing = await findMachineLocalEntryIds(
      '- id: a\n  name: dsh-context\n- id: b\n  name: github:owner/repo\n',
    )
    expect(missing).toEqual([])
  })
})

describe('mergePatchText', () => {
  it('skips a machine-local file entry and still merges the portable ones', async () => {
    const remote = makeConfigFile({
      path: 'cordis.patch.yml',
      kind: 'home-patch',
      content: remotePatch('file:///definitely/not/here/plugin.mjs'),
    })
    const result = await mergePatchText(LOCAL, remote, null)
    expect(result.skipped.map(entry => entry.id)).toEqual(['onesuite-pilot-observability'])
    expect(result.text).toContain('llm-pi-ai')
    expect(result.text).toContain('providers:')
    // The machine-local entry is not imported and its path is not leaked.
    expect(result.text).not.toContain('onesuite-pilot-observability')
    expect(result.text).not.toContain('definitely/not/here')
    // The local entry the remote never had survives.
    expect(result.text).toContain('local-only')
  })

  it('adopts a file entry that does exist on this device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apply-merge-'))
    roots.push(root)
    const target = join(root, 'plugin.mjs')
    await writeFile(target, 'export default function apply() {}\n', 'utf8')
    const remote = makeConfigFile({
      path: 'cordis.patch.yml',
      kind: 'home-patch',
      content: remotePatch(`'file://${target}'`),
    })
    const result = await mergePatchText(LOCAL, remote, null)
    expect(result.skipped).toEqual([])
    expect(result.text).toContain('onesuite-pilot-observability')
  })
})

describe('isMachineLocalSpec', () => {
  it('recognizes path-shaped dependency specs', () => {
    expect(isMachineLocalSpec('link:/Users/me/plugin')).toBe(true)
    expect(isMachineLocalSpec('file:../plugin')).toBe(true)
    expect(isMachineLocalSpec('workspace:*')).toBe(true)
    expect(isMachineLocalSpec('portal:/tmp/x')).toBe(true)
    expect(isMachineLocalSpec('github:owner/repo#abc')).toBe(false)
    expect(isMachineLocalSpec('dsh-context@0.81.2')).toBe(false)
    expect(isMachineLocalSpec('^1.2.3')).toBe(false)
  })
})

describe('mergePackageText', () => {
  const local = JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      dependencies: { 'dsh-ssh-hosts': 'github:alfredhuang211/dsh-ssh-hosts#0c67db6' },
      dsh: { profile: { bundles: ['dsh-ssh-hosts'] } },
    },
    null,
    2,
  )

  it('takes portable specs and reports machine-local ones instead of writing dangling paths', () => {
    const remote = makeConfigFile({
      path: 'profiles/desktop/package.json',
      kind: 'profile-package',
      content: JSON.stringify(
        {
          name: 'dsh-profile-desktop',
          dependencies: {
            'dsh-ssh-hosts': 'link:/Users/other/dsh-ssh-hosts',
            'dsh-context': '0.81.2',
            'dsh-ai-passport': 'file:/Users/other/passport',
            'dsh-webdav-sync': 'workspace:*',
          },
          dsh: { profile: { bundles: ['dsh-ssh-hosts', 'dsh-context'] } },
        },
        null,
        2,
      ),
    })
    const result = mergePackageText(local, remote, null)
    const parsed = JSON.parse(result.text) as { dependencies: Record<string, string> }
    // Portable entries are adopted...
    expect(parsed.dependencies['dsh-context']).toBe('0.81.2')
    // ...the local reproducible spec is kept instead of the other device's path...
    expect(parsed.dependencies['dsh-ssh-hosts']).toBe('github:alfredhuang211/dsh-ssh-hosts#0c67db6')
    // ...and path-only dependencies never land in this file.
    expect(parsed.dependencies['dsh-ai-passport']).toBeUndefined()
    expect(parsed.dependencies['dsh-webdav-sync']).toBeUndefined()
    expect(result.skipped.map(entry => entry.name).sort()).toEqual(['dsh-ai-passport', 'dsh-ssh-hosts', 'dsh-webdav-sync'])
  })
})
