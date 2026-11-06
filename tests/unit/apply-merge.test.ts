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
import { findMachineLocalEntryIds, mergePatchText, scanPatchEntryNames } from '../../src/engine/apply.js'
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
