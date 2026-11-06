/**
 * Tests for the inventory helpers: filtering, counts, and the MCP display
 * projections (names only — never a header or environment value).
 */

import { describe, expect, it } from 'vitest'
import type { InventoryMcpRow, InventoryPluginRow, InventoryResponse } from '../../src/http/api-types.js'
import {
  countEnabledPlugins,
  countRestorablePlugins,
  filterPlugins,
  hiddenOfficialPlugins,
  mcpEndpoint,
  mcpEnvNames,
  mcpHeaderNames,
  mcpPackageLabel,
  mcpRows,
  pluginRows,
  providerRows,
} from '../../client/src/inventory'

/** One plugin row. */
function plugin(patch: Partial<InventoryPluginRow> = {}): InventoryPluginRow {
  return {
    id: 'npm:@deepseek-ai/dsh-plugin-alpha',
    name: '@deepseek-ai/dsh-plugin-alpha',
    version: '1.4.0',
    origin: 'npm',
    enabled: true,
    installSpec: 'npm:@deepseek-ai/dsh-plugin-alpha@1.4.0',
    restorable: true,
    builtIn: false,
    syncable: true,
    ...patch,
  }
}

/** One MCP row. */
function mcp(patch: Partial<InventoryMcpRow> = {}): InventoryMcpRow {
  return {
    id: 'mcp:github',
    serverName: 'github',
    transport: 'stdio',
    installMethod: 'npx',
    packageName: '@modelcontextprotocol/server-github',
    packageVersion: '2.0.0',
    command: 'npx -y @modelcontextprotocol/server-github',
    headerNames: ['Authorization'],
    envNames: ['GITHUB_TOKEN'],
    enabled: true,
    ...patch,
  }
}

/** A whole inventory response. */
function response(patch: Partial<InventoryResponse> = {}): InventoryResponse {
  return {
    profile: 'default',
    plugins: [plugin()],
    providers: [{ id: 'openai', displayName: 'OpenAI', api: 'openai-completions', models: 3 }],
    mcp: [mcp()],
    secrets: { refs: 2, records: 0, encrypted: true },
    dsh: { files: 3, entries: 12, bundles: 4 },
    ...patch,
  }
}

describe('row projections', () => {
  it('returns empty lists before the inventory arrives', () => {
    expect(pluginRows(null)).toEqual([])
    expect(mcpRows(null)).toEqual([])
    expect(providerRows(null)).toEqual([])
  })

  it('returns the rows of a loaded inventory', () => {
    const inventory = response()
    expect(pluginRows(inventory)).toBe(inventory.plugins)
    expect(mcpRows(inventory)).toBe(inventory.mcp)
    expect(providerRows(inventory)).toBe(inventory.providers)
  })
})

describe('filterPlugins', () => {
  const rows = [
    plugin(),
    plugin({
      id: 'local:my-plugin',
      name: 'my-plugin',
      version: null,
      origin: 'local-path',
      installSpec: null,
      restorable: false,
      enabled: false,
    }),
    plugin({
      id: 'official:bundled',
      name: 'bundled-plugin',
      version: '0.1.0',
      origin: 'official',
      installSpec: 'npm:bundled-plugin@0.1.0',
      builtIn: true,
    }),
  ]

  it('returns every row for an empty query', () => {
    expect(filterPlugins(rows, '')).toHaveLength(3)
    expect(filterPlugins(rows, '   ')).toHaveLength(3)
  })

  it('matches name, id, origin, version, and install spec, ignoring case', () => {
    expect(filterPlugins(rows, 'ALPHA')).toEqual([rows[0]])
    expect(filterPlugins(rows, 'local:')).toEqual([rows[1]])
    expect(filterPlugins(rows, 'official')).toEqual([rows[2]])
    expect(filterPlugins(rows, '1.4.0')).toEqual([rows[0]])
    expect(filterPlugins(rows, 'npm:bundled')).toEqual([rows[2]])
  })

  it('does not mutate or share the input array', () => {
    const filtered = filterPlugins(rows, '')
    expect(filtered).not.toBe(rows)
    expect(rows).toHaveLength(3)
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterPlugins(rows, 'nothing-like-this')).toEqual([])
  })
})

describe('plugin counts', () => {
  it('counts enabled and restorable plugins', () => {
    const rows = [plugin(), plugin({ id: 'b', enabled: false }), plugin({ id: 'c', restorable: false })]
    expect(countEnabledPlugins(rows)).toBe(2)
    expect(countRestorablePlugins(rows)).toBe(2)
  })
})

describe('MCP projections', () => {
  it('prefers the URL, then the command, then an empty string', () => {
    expect(mcpEndpoint(mcp({ url: 'https://mcp.example.com/sse' }))).toBe('https://mcp.example.com/sse')
    expect(mcpEndpoint(mcp())).toBe('npx -y @modelcontextprotocol/server-github')
    expect(mcpEndpoint(mcp({ command: undefined }))).toBe('')
  })

  it('labels a package with and without a version', () => {
    expect(mcpPackageLabel(mcp())).toBe('@modelcontextprotocol/server-github@2.0.0')
    expect(mcpPackageLabel(mcp({ packageVersion: undefined }))).toBe('@modelcontextprotocol/server-github')
    expect(mcpPackageLabel(mcp({ packageName: undefined }))).toBe('')
  })

  it('lists header and environment names only, dropping blanks', () => {
    expect(mcpHeaderNames(mcp({ headerNames: ['Authorization', '  ', 'X-Api-Key'] }))).toEqual([
      'Authorization',
      'X-Api-Key',
    ])
    expect(mcpEnvNames(mcp({ envNames: ['  ', 'GITHUB_TOKEN'] }))).toEqual(['GITHUB_TOKEN'])
    expect(mcpHeaderNames(mcp({ headerNames: [] }))).toEqual([])
  })
})

describe('hiddenOfficialPlugins', () => {
  /** Minimal response wrapping the given rows plus a hidden count. */
  function response(hidden: number | undefined): InventoryResponse {
    return {
      profile: 'desktop',
      plugins: [],
      providers: [],
      mcp: [],
      secrets: { refs: 0, records: 0, encrypted: false },
      dsh: { files: 0, entries: 0, bundles: 0 },
      ...(hidden === undefined ? {} : { hiddenOfficialPlugins: hidden }),
    }
  }

  it('reports the count the Host excluded from the plugin rows', () => {
    expect(hiddenOfficialPlugins(response(26))).toBe(26)
  })

  it('treats an absent, zero or invalid count as nothing hidden', () => {
    expect(hiddenOfficialPlugins(response(undefined))).toBe(0)
    expect(hiddenOfficialPlugins(response(0))).toBe(0)
    expect(hiddenOfficialPlugins(response(-3))).toBe(0)
    expect(hiddenOfficialPlugins(response(Number.NaN))).toBe(0)
    expect(hiddenOfficialPlugins(null)).toBe(0)
  })
})
