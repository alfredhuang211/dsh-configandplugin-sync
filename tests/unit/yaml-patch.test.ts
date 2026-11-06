/**
 * Patch-file surgery and YAML emitting.
 *
 * These two modules are what make a cross-device restore safe: blocks that the
 * remote did not touch must come back byte for byte, including comments and
 * `!!js` expressions that a YAML round-trip would flatten.
 */
import { describe, expect, it } from 'vitest'
import { mergePatch, patchEntryIds, preserveMaskedValues, removeBlock, splitPatch, upsertBlock } from '../../src/core/patch.js'
import { maskYamlSecrets } from '../../src/core/redact.js'
import { emitPatchEntry, emitYaml, RawExpression } from '../../src/core/yaml.js'

const LOCAL = `# my profile patch
- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
  config:
    transcriptView: standard

# keep this comment
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      tflow:
        apiKeyEnv: TFLOW_API_KEY
        api: openai-completions
`

describe('splitPatch', () => {
  it('splits top-level entries and keeps comments verbatim', () => {
    const split = splitPatch(LOCAL)
    expect(split.blocks).toHaveLength(2)
    expect(split.preamble).toContain('# my profile patch')
    expect(split.blocks[0]?.id).toBe('ui-chat')
    expect(split.blocks[1]?.id).toBe('llm-pi-ai')
    expect(split.blocks[1]?.text).toContain('# keep this comment')
    expect(split.blocks[1]?.text).toContain('apiKeyEnv: TFLOW_API_KEY')
  })

  it('finds ids declared inside an insert block', () => {
    const text = `- insert:
  - id: a
    name: pkg-a
  - id: b
    name: pkg-b
- id: c
  name: pkg-c
`
    const split = splitPatch(text)
    expect(split.blocks).toHaveLength(2)
    expect(split.blocks[0]?.insertIds).toEqual(['a', 'b'])
    expect([...patchEntryIds(split)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('treats an empty file as no blocks', () => {
    expect(splitPatch('').blocks).toEqual([])
    expect(splitPatch('[]\n').blocks).toEqual([])
  })
})

describe('mergePatch', () => {
  it('replaces only the entries it is told to take, preserving the rest', () => {
    const remote = `- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
  config:
    transcriptView: compact
- id: webdav-sync
  name: dsh-webdav-sync
  config:
    sync:
      enabled: true
`
    const result = mergePatch(LOCAL, remote, { takeIds: ['ui-chat'] })
    expect(result.text).toContain('transcriptView: compact')
    // The untouched local entry keeps its comment and its value.
    expect(result.text).toContain('# keep this comment')
    expect(result.text).toContain('apiKeyEnv: TFLOW_API_KEY')
    expect(result.text).not.toContain('webdav-sync')
    expect(result.changedIds).toEqual(['ui-chat'])
  })

  it('appends an entry the local patch does not have', () => {
    const remote = `- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
`
    const result = mergePatch(LOCAL, remote, {
      takeIds: [],
      additions: [
        {
          id: 'mcp-github',
          entry: {
            id: 'mcp-github',
            name: '@deepseek-ai/dsh-mcp-client',
            config: { serverName: 'github', transport: 'stdio', command: 'npx' },
          },
        },
      ],
    })
    expect(result.addedIds).toEqual(['mcp-github'])
    expect(result.text).toContain('id: mcp-github')
    expect(result.text).toContain('transport: stdio')
  })

  it('drops an entry on an explicit removal', () => {
    const result = mergePatch(LOCAL, '', { takeIds: [], dropIds: ['ui-chat'] })
    expect(result.removedIds).toEqual(['ui-chat'])
    expect(result.text).not.toContain('ui-chat')
    expect(result.text).toContain('llm-pi-ai')
  })

  it('keeps a local-only entry when the remote file has fewer entries', () => {
    const remote = '- id: ui-chat\n  name: x\n'
    const result = mergePatch(LOCAL, remote, { takeIds: ['ui-chat'] })
    expect(result.text).toContain('llm-pi-ai')
  })

  it('is injective on an empty local document', () => {
    const remote = '- id: a\n  name: pkg-a\n'
    const result = mergePatch('', remote, { takeIds: ['a'] })
    expect(result.text).toContain('pkg-a')
  })
})

describe('upsertBlock / removeBlock', () => {
  it('adds a block when the id is absent and replaces it when present', () => {
    const added = upsertBlock(LOCAL, 'mcp-web', { id: 'mcp-web', config: { serverName: 'web' } })
    expect(added).toContain('id: mcp-web')
    expect(added).toContain('serverName: web')
    const replaced = upsertBlock(added, 'mcp-web', { id: 'mcp-web', config: { serverName: 'web2' } })
    expect(replaced).toContain('serverName: web2')
    expect(replaced.match(/id: mcp-web/g)).toHaveLength(1)
    expect(removeBlock(replaced, 'mcp-web')).not.toContain('mcp-web')
  })
})

describe('emitYaml', () => {
  it('emits maps, lists, scalars and raw expressions', () => {
    const text = emitPatchEntry({
      id: 'mcp-github',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: new RawExpression('!!js process.env.GITHUB_TOKEN') },
        enabled: true,
        retries: 3,
      },
    })
    expect(text).toContain('- id: mcp-github')
    expect(text).toContain("- '-y'")
    expect(text).toContain('!!js process.env.GITHUB_TOKEN')
    expect(text).toContain('enabled: true')
    expect(text).toContain('retries: 3')
  })

  it('quotes ambiguous scalars', () => {
    const text = emitYaml({ a: 'true', b: '1.5', c: 'has: colon', d: '', e: 'plain' })
    expect(text).toContain("a: 'true'")
    expect(text).toContain("b: '1.5'")
    expect(text).toContain("d: ''")
    expect(text).toContain('e: plain')
  })

  it('emits empty collections inline', () => {
    expect(emitYaml({ a: [], b: {} })).toBe('a: []\nb: {}')
  })

  it('refuses to emit a non-JSON value', () => {
    expect(() => emitYaml({ a: Number.NaN })).toThrow()
  })
})

describe('secret masking of configuration text', () => {
  const patch = `- id: webdav-sync
  name: dsh-webdav-sync
  config:
    sync:
      remoteUrl: http://example/dav
      username: alfred
      password: hunter2-plain
      tokenEnv: DAV_TOKEN
    headers:
      Authorization: Bearer sk-live-abcdefghijkl
`

  it('masks a value but keeps the document shape', () => {
    const { text, masked } = maskYamlSecrets(patch)
    expect(text).toContain('password: "***"')
    expect(text).toContain('Authorization: "***"')
    expect(text).not.toContain('hunter2-plain')
    expect(text).not.toContain('sk-live-abcdefghijkl')
    // A reference-shaped value and a benign field are untouched.
    expect(text).toContain('tokenEnv: DAV_TOKEN')
    expect(text).toContain('remoteUrl: http://example/dav')
    expect(masked.map(item => item.key).sort()).toEqual(['Authorization', 'password'])
    // The masked text is still a mergeable patch document.
    expect(splitPatch(text).blocks).toHaveLength(1)
  })

  it('puts the local value back on restore and reports what stayed masked', () => {
    const local = patch.replace('hunter2-plain', 'local-real-password').replace('Bearer sk-live-abcdefghijkl', 'Bearer local-token')
    const remoteMasked = maskYamlSecrets(patch).text
    const result = preserveMaskedValues(local, remoteMasked)
    expect(result.text).toContain('password: local-real-password')
    expect(result.text).toContain('Authorization: Bearer local-token')
    expect(result.restored.sort()).toEqual(['Authorization', 'password'])
    expect(result.unresolved).toEqual([])
  })

  it('leaves a mask in place when the device has no local value', () => {
    const empty = '- id: webdav-sync\n  name: dsh-webdav-sync\n'
    const remoteMasked = maskYamlSecrets(patch).text
    const result = preserveMaskedValues(empty, remoteMasked)
    expect(result.text).toContain('"***"')
    expect(result.restored).toEqual([])
    expect(result.unresolved.sort()).toEqual(['Authorization', 'password'])
  })

  it('does not guess when two local values share a key and indentation', () => {
    const remoteMasked = maskYamlSecrets(patch).text
    const ambiguous = `${patch.replace('hunter2-plain', 'first')}\n- id: other\n  config:\n    sync:\n      password: second\n`
    const result = preserveMaskedValues(ambiguous, remoteMasked)
    expect(result.unresolved).toContain('password')
  })
})
