/**
 * Collector tests: MCP server records.
 *
 * Focus: install-method inference for npx / uvx / pip / npm / docker / HTTP,
 * package and version parsing from the argument list, and the promise that only
 * header and environment *names* cross into a record.
 */

import { describe, expect, it } from 'vitest'
import { toConfigEntryRecord, type RawEntry } from '../../src/collect/entries.js'
import {
  collectMcpServers,
  findPackageSpec,
  inferInstallMethod,
  parsePackageSpec,
  redactArgs,
} from '../../src/collect/mcp.js'
import type { ConfigEntryRecord } from '../../src/types.js'

/** Build an MCP entry the way the collector receives it (already scrubbed). */
function mcpEntry(id: string, config: Record<string, unknown>, disabled = false): ConfigEntryRecord {
  const raw: RawEntry = { id, name: '@deepseek-ai/dsh-mcp-client', config, source: 'config-editor' }
  if (disabled) raw.disabled = true
  return toConfigEntryRecord(raw)
}

/** A non-MCP entry that must be ignored. */
function otherEntry(id: string, config: Record<string, unknown> = {}): ConfigEntryRecord {
  return toConfigEntryRecord({ id, name: 'dsh-something-else', config, source: 'config-editor' })
}

describe('parsePackageSpec', () => {
  it('parses scoped, unscoped, pinned and unpinned specs', () => {
    expect(parsePackageSpec('@modelcontextprotocol/server-github@0.6.2')).toEqual({
      name: '@modelcontextprotocol/server-github',
      version: '0.6.2',
    })
    expect(parsePackageSpec('pkg@latest')).toEqual({ name: 'pkg' })
    expect(parsePackageSpec('pkg@^2.0.0')).toEqual({ name: 'pkg' })
    expect(parsePackageSpec('mcp-server-git')).toEqual({ name: 'mcp-server-git' })
    expect(parsePackageSpec('pkg==1.4.0')).toEqual({ name: 'pkg', version: '1.4.0' })
    expect(parsePackageSpec('ghcr.io/foo/bar:1.2.3')).toEqual({ name: 'ghcr.io/foo/bar', version: '1.2.3' })
    expect(parsePackageSpec('-y')).toBeNull()
  })
})

describe('findPackageSpec', () => {
  it('finds the package in npx, uvx, npm exec, pip and docker invocations', () => {
    expect(findPackageSpec('npx', ['-y', '@modelcontextprotocol/server-github@0.6.2'])).toEqual({
      name: '@modelcontextprotocol/server-github',
      version: '0.6.2',
    })
    expect(findPackageSpec('uvx', ['mcp-server-git', '--repository', '/tmp/repo'])).toEqual({ name: 'mcp-server-git' })
    expect(findPackageSpec('uvx', ['--from', 'mcp-server-git==1.2.3', 'mcp-server-git'])).toEqual({
      name: 'mcp-server-git',
      version: '1.2.3',
    })
    expect(findPackageSpec('npm', ['exec', 'pkg-a@2.0.0'])).toEqual({ name: 'pkg-a', version: '2.0.0' })
    expect(findPackageSpec('pip3', ['install', 'mcp-server-fetch==0.3.0'])).toEqual({
      name: 'mcp-server-fetch',
      version: '0.3.0',
    })
    expect(findPackageSpec('docker', ['run', '-i', '--rm', '-e', 'TOKEN=x', 'ghcr.io/foo/bar:1.2.3', 'serve'])).toEqual({
      name: 'ghcr.io/foo/bar',
      version: '1.2.3',
    })
  })
})

describe('inferInstallMethod', () => {
  it('maps executables and transports onto the install-method enum', () => {
    expect(inferInstallMethod('stdio', { command: '/usr/local/bin/npx', args: [] })).toBe('npx')
    expect(inferInstallMethod('stdio', { command: 'uvx', args: [] })).toBe('uvx')
    expect(inferInstallMethod('stdio', { command: 'pip', args: [] })).toBe('pip')
    expect(inferInstallMethod('stdio', { command: 'python3', args: ['-m', 'pip', 'install', 'x'] })).toBe('pip')
    expect(inferInstallMethod('stdio', { command: 'npm', args: [] })).toBe('npm')
    expect(inferInstallMethod('stdio', { command: 'docker', args: [] })).toBe('docker')
    expect(inferInstallMethod('stdio', { command: '/opt/bin/my-mcp-server', args: [] })).toBe('binary')
    expect(inferInstallMethod('streamable-http', {})).toBe('http')
    expect(inferInstallMethod('stdio', {})).toBe('unknown')
  })
})

describe('redactArgs', () => {
  it('masks secret flag values and embedded credentials', () => {
    expect(redactArgs(['--api-key', 'super-secret', '--verbose'])).toEqual(['--api-key', '***', '--verbose'])
    expect(redactArgs(['--token=abcdef123456'])).toEqual(['--token=***'])
    expect(redactArgs(['GITHUB_TOKEN=ghp_secret_value_here'])).toEqual(['GITHUB_TOKEN=***'])
    expect(redactArgs(['--url', 'https://user:pass@example.com/mcp'])).toEqual([
      '--url',
      'https://user:***@example.com/mcp',
    ])
    expect(redactArgs(['--model', 'gpt-5'])).toEqual(['--model', 'gpt-5'])
  })
})

describe('collectMcpServers', () => {
  it('records a stdio npx server with names only', () => {
    const result = collectMcpServers([
      mcpEntry('mcp-github', {
        serverName: 'github',
        transport: 'stdio',
        command: '/usr/local/bin/npx',
        args: ['-y', '@modelcontextprotocol/server-github@0.6.2'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret_token_value_1234', LOG_LEVEL: 'debug' },
        cwd: '/tmp/work',
        toolCallTimeoutMs: 60000,
        failOnStartupError: true,
        reconnect: { attempts: 3 },
      }),
    ])

    expect(result.servers).toHaveLength(1)
    const server = result.servers[0]
    expect(server?.id).toBe('mcp:github')
    expect(server?.entryId).toBe('mcp-github')
    expect(server?.transport).toBe('stdio')
    expect(server?.installMethod).toBe('npx')
    expect(server?.packageName).toBe('@modelcontextprotocol/server-github')
    expect(server?.packageVersion).toBe('0.6.2')
    expect(server?.command).toBe('/usr/local/bin/npx')
    expect(server?.cwd).toBe('/tmp/work')
    expect(server?.envNames).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN', 'LOG_LEVEL'])
    expect(server?.headerNames).toEqual([])
    expect(server?.config).toEqual({ toolCallTimeoutMs: 60000, failOnStartupError: true, reconnect: { attempts: 3 } })
    expect(server?.enabled).toBe(true)

    const serialized = JSON.stringify(result.servers)
    expect(serialized).not.toContain('ghp_secret_token_value_1234')
    expect(serialized).not.toContain('debug"')
  })

  it('records a uvx server with an unpinned package', () => {
    const result = collectMcpServers([
      mcpEntry('mcp-git', {
        serverName: 'git',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git', '--repository', '/tmp/repo'],
        env: {},
        cwd: '',
      }),
    ])
    const server = result.servers[0]
    expect(server?.installMethod).toBe('uvx')
    expect(server?.packageName).toBe('mcp-server-git')
    expect(server?.packageVersion).toBeUndefined()
    expect(server?.args).toEqual(['mcp-server-git', '--repository', '/tmp/repo'])
  })

  it('records an HTTP server, masking URL credentials and header values', () => {
    const result = collectMcpServers([
      mcpEntry('mcp-remote', {
        serverName: 'remote',
        transport: 'streamable-http',
        url: 'https://user:passw0rd@mcp.example.com/sse',
        headers: { Authorization: 'Bearer abcdefghijklmnop', 'X-Tenant': 'acme' },
        toolCallTimeoutMs: 30000,
      }),
    ])
    const server = result.servers[0]
    expect(server?.transport).toBe('streamable-http')
    expect(server?.installMethod).toBe('http')
    expect(server?.command).toBeUndefined()
    expect(server?.url).toBe('https://mcp.example.com/sse')
    expect(server?.headerNames).toEqual(['Authorization', 'X-Tenant'])
    expect(server?.config).toEqual({ toolCallTimeoutMs: 30000 })
    const serialized = JSON.stringify(result.servers)
    expect(serialized).not.toContain('passw0rd')
    expect(serialized).not.toContain('abcdefghijklmnop')
  })

  it('records a docker server with a pinned image', () => {
    const result = collectMcpServers([
      mcpEntry('mcp-docker', {
        serverName: 'dockerised',
        transport: 'stdio',
        command: 'docker',
        args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN=ghp_hidden_value', 'ghcr.io/foo/bar:1.2.3', 'serve'],
      }),
    ])
    const server = result.servers[0]
    expect(server?.installMethod).toBe('docker')
    expect(server?.packageName).toBe('ghcr.io/foo/bar')
    expect(server?.packageVersion).toBe('1.2.3')
    expect(server?.args).toEqual(['run', '-i', '--rm', '-e', 'GITHUB_TOKEN=***', 'ghcr.io/foo/bar:1.2.3', 'serve'])
  })

  it('masks a secret passed as a flag value', () => {
    const result = collectMcpServers([
      mcpEntry('mcp-flag', {
        serverName: 'flagged',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-server@1.0.0', '--api-key', 'sk-live-abcdef1234567890'],
      }),
    ])
    expect(result.servers[0]?.args).toEqual(['-y', 'some-server@1.0.0', '--api-key', '***'])
    expect(JSON.stringify(result.servers)).not.toContain('sk-live-abcdef1234567890')
  })

  it('falls back to the entry id for the server name and honours disabled', () => {
    const result = collectMcpServers([
      mcpEntry('mcp-unnamed', { transport: 'stdio', command: 'npx', args: ['srv@1.0.0'] }, true),
    ])
    expect(result.servers[0]?.serverName).toBe('mcp-unnamed')
    expect(result.servers[0]?.enabled).toBe(false)
  })

  it('ignores entries that are not MCP servers and warns on duplicates', () => {
    const warnings: string[] = []
    const result = collectMcpServers(
      [
        otherEntry('ui-chat', { transcriptView: 'standard' }),
        mcpEntry('a', { serverName: 'same', transport: 'stdio', command: 'npx', args: ['one@1.0.0'] }),
        mcpEntry('b', { serverName: 'same', transport: 'stdio', command: 'npx', args: ['two@2.0.0'] }),
      ],
      { warnings },
    )
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]?.entryId).toBe('b')
    expect(warnings.some(warning => warning.includes('same'))).toBe(true)
  })
})
