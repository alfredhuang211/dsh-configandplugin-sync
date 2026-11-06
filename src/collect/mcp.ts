/**
 * MCP server collection.
 *
 * One `@deepseek-ai/dsh-mcp-client` Loader entry defines one MCP server. This
 * module turns each entry into a {@link McpServerRecord} that is enough to
 * re-create the server on another device *without* carrying secret material:
 * the transport, how the server program is obtained (npx / uvx / pip / npm /
 * docker / binary / HTTP), the package and its pinned version, the arguments
 * with credential values masked, and only the *names* of headers and
 * environment variables — never their values.
 *
 * `headerNames`/`envNames` are names for the same reason a provider records
 * `apiKeyEnv` instead of the key: the value is the secret, the name is the
 * contract.
 * @module collect/mcp
 */

import type { ConfigEntryRecord, JsonObject, McpInstallMethod, McpServerRecord } from '../types.js'
import { asJsonObject, isJsonValue, sanitizeJson, stringField } from '../core/json.js'
import { isSecretKey, redactText, sanitizeUrl } from '../core/redact.js'

/** Module name of the MCP client bridge plugin. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Transports the record type knows about. */
const KNOWN_TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse'])

/** Executables that imply a package-manager install method. */
const COMMAND_METHODS: Readonly<Record<string, McpInstallMethod>> = {
  npx: 'npx',
  bunx: 'npx',
  pnpx: 'npx',
  uvx: 'uvx',
  pip: 'pip',
  pip3: 'pip',
  npm: 'npm',
  docker: 'docker',
}

/** Config keys that are represented by a dedicated record field. */
const HANDLED_KEYS = new Set([
  'serverName',
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
])

/** Result of collecting one profile's MCP servers. */
export interface McpCollectResult {
  servers: McpServerRecord[]
  warnings: string[]
}

/** Options of {@link collectMcpServers}. */
export interface McpCollectOptions {
  /** Warnings sink; the caller owns logging. */
  warnings?: string[]
}

/** A parsed package/image reference. */
interface PackageSpec {
  name: string
  version?: string
}

/** Read a trimmed non-empty string, or undefined. */
function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Whether one entry looks like an MCP client entry. */
function isMcpEntry(entry: ConfigEntryRecord): boolean {
  const name = entry.name ?? ''
  if (name === MCP_CLIENT_MODULE || name.includes('mcp-client')) return true
  const config = entry.config
  if (typeof config['serverName'] !== 'string') return false
  return config['transport'] !== undefined || config['command'] !== undefined || config['url'] !== undefined
}

/** Read the transport, tolerating absence and unknown spellings. */
function readTransport(config: JsonObject): McpServerRecord['transport'] {
  const declared = stringField(config, 'transport')
  if (declared !== undefined && KNOWN_TRANSPORTS.has(declared)) {
    return declared as McpServerRecord['transport']
  }
  if (declared !== undefined) return 'unknown'
  if (stringField(config, 'url') !== undefined) return 'streamable-http'
  if (stringField(config, 'command') !== undefined) return 'stdio'
  return 'unknown'
}

/** Whether a token is a command-line flag rather than a value. */
function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-'
}

/** Base name of an executable, without a Windows extension. */
function executableName(command: string): string {
  const file = command.split(/[\\/]/).pop() ?? command
  return file.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/** Infer how the MCP server program is obtained and started. */
export function inferInstallMethod(transport: McpServerRecord['transport'], config: JsonObject): McpInstallMethod {
  if (transport !== 'stdio') return 'http'
  const command = stringField(config, 'command')
  if (command === undefined) return 'unknown'
  const base = executableName(command)
  const mapped = COMMAND_METHODS[base]
  if (mapped !== undefined) return mapped
  // `python -m pip install …` starts via the interpreter but installs with pip.
  if (/^python[0-9.]*$/.test(base)) {
    const args = readStringArray(config['args'])
    if (args.some(arg => arg === '-m') && args.includes('pip')) return 'pip'
    return 'binary'
  }
  return 'binary'
}

/** Read a string array defensively. */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

/** Whether a version suffix pins an exact version. */
function isPinnedVersion(version: string): boolean {
  if (version === '' || version === '*' || version === 'latest' || version === 'next') return false
  if (/[\s^~<>=|]/.test(version)) return false
  if (/^x$/i.test(version)) return false
  return true
}

/**
 * Parse one package/image reference.
 *
 * Supports `pkg`, `@scope/pkg`, `pkg@1.2.3`, `@scope/pkg@latest`,
 * `pkg==1.2.3` (pip) and `registry/owner/image:tag` (docker).
 */
export function parsePackageSpec(specInput: string): PackageSpec | null {
  const spec = specInput.trim()
  if (spec === '' || isFlag(spec)) return null
  if (spec.includes('==')) {
    const separator = spec.indexOf('==')
    const name = spec.slice(0, separator)
    const version = spec.slice(separator + 2)
    if (name === '') return null
    const parsed: PackageSpec = { name }
    if (isPinnedVersion(version)) parsed.version = version
    return parsed
  }
  const at = spec.lastIndexOf('@')
  if (at > 0) {
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    if (name === '') return null
    const parsed: PackageSpec = { name }
    if (isPinnedVersion(version)) parsed.version = version
    return parsed
  }
  // Docker-style image with a tag: the tag separator is the last `:` after the
  // last `/`, so a registry port is not mistaken for one.
  const lastSlash = spec.lastIndexOf('/')
  const lastColon = spec.lastIndexOf(':')
  if (lastColon > lastSlash) {
    const name = spec.slice(0, lastColon)
    const version = spec.slice(lastColon + 1)
    if (name !== '') {
      const parsed: PackageSpec = { name }
      if (isPinnedVersion(version)) parsed.version = version
      return parsed
    }
  }
  return { name: spec }
}

/** Find the package/image a command invocation names, if any. */
export function findPackageSpec(command: string, args: readonly string[]): PackageSpec | null {
  const base = executableName(command)
  if (base === 'docker') {
    // `docker run [flags] <image> [args…]`: the first non-flag token after the
    // subcommand is the image.
    let sawRun = false
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? ''
      if (!sawRun) {
        if (arg === 'run') sawRun = true
        continue
      }
      if (isFlag(arg)) {
        // Flags such as `-e VAR=value` consume the next token.
        if (arg === '-e' || arg === '--env' || arg === '-v' || arg === '--volume' || arg === '-p' || arg === '--publish' || arg === '--name') {
          index += 1
        }
        continue
      }
      return parsePackageSpec(arg)
    }
    return null
  }
  if (base === 'uvx') {
    const fromIndex = args.indexOf('--from')
    if (fromIndex !== -1) {
      const fromSpec = args[fromIndex + 1]
      if (fromSpec !== undefined) return parsePackageSpec(fromSpec)
    }
  }
  for (const arg of args) {
    if (isFlag(arg)) continue
    // Sub-commands of the package managers are not package names.
    if (base === 'npm' && (arg === 'exec' || arg === 'x' || arg === 'install' || arg === 'i')) continue
    if (base === 'pip' || base === 'pip3') {
      if (arg === 'install') continue
    }
    return parsePackageSpec(arg)
  }
  return null
}

/** Mask secret-looking values in one argument list. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = []
  let nextValueIsSecret = false
  for (const arg of args) {
    if (isFlag(arg)) {
      const flagName = (arg.replace(/^-+/, '').split('=')[0] ?? '').toLowerCase()
      if (arg.includes('=')) {
        const separator = arg.indexOf('=')
        const name = arg.slice(0, separator)
        const value = arg.slice(separator + 1)
        out.push(isSecretKey(flagName) && value !== '' ? `${name}=***` : arg)
        nextValueIsSecret = false
        continue
      }
      nextValueIsSecret = isSecretKey(flagName)
      out.push(arg)
      continue
    }
    if (nextValueIsSecret) {
      out.push('***')
      nextValueIsSecret = false
      continue
    }
    const separator = arg.indexOf('=')
    if (separator > 0) {
      const name = arg.slice(0, separator)
      if (isSecretKey(name)) {
        out.push(`${name}=***`)
        continue
      }
    }
    // Mask embedded credentials (a URL userinfo part, a provider key, a token).
    out.push(redactText(arg))
  }
  return out
}

/** Collect the names of a string mapping, never its values. */
function mappingNames(value: unknown): string[] {
  const record = asJsonObject(value)
  if (record === null) return []
  return Object.keys(record).sort()
}

/** Build the non-secret remainder of an MCP config. */
function remainingConfig(config: JsonObject): JsonObject {
  const rest: JsonObject = {}
  for (const [key, value] of Object.entries(config)) {
    if (HANDLED_KEYS.has(key)) continue
    if (isSecretKey(key)) continue
    if (!isJsonValue(value)) continue
    rest[key] = value
  }
  const sanitized = asJsonObject(sanitizeJson(rest)) ?? {}
  return sanitized
}

/** Build one record from one entry; null when the entry cannot be named. */
function buildServerRecord(entry: ConfigEntryRecord): McpServerRecord | null {
  const config = entry.config
  const serverName = stringField(config, 'serverName') ?? entry.id
  if (serverName === '') return null
  const transport = readTransport(config)
  const installMethod = inferInstallMethod(transport, config)
  const command = stringField(config, 'command')
  const rawArgs = readStringArray(config['args'])
  const args = redactArgs(rawArgs)
  const headerNames = mappingNames(config['headers'])
  const envNames = mappingNames(config['env'])

  const record: McpServerRecord = {
    id: `mcp:${serverName}`,
    serverName,
    entryId: entry.id,
    transport,
    installMethod,
    args,
    headerNames,
    envNames,
    config: remainingConfig(config),
    enabled: entry.disabled !== true,
  }
  if (command !== undefined) record.command = command
  const cwd = stringField(config, 'cwd')
  if (cwd !== undefined) record.cwd = cwd
  const url = stringField(config, 'url')
  if (url !== undefined) {
    const sanitizedUrl = redactText(sanitizeUrl(url))
    // `***` means the endpoint itself was credential-bearing; publishing a
    // placeholder would produce an unusable server on another device.
    if (sanitizedUrl !== '***' && !sanitizedUrl.includes('***')) record.url = sanitizedUrl
  }

  if (command !== undefined && transport === 'stdio') {
    const spec = findPackageSpec(command, rawArgs)
    if (spec !== null) {
      record.packageName = spec.name
      if (spec.version !== undefined) record.packageVersion = spec.version
    }
  }
  return record
}

/**
 * Collect every MCP server entry of one profile.
 *
 * Duplicate `serverName` declarations (two entries pointing at the same
 * namespace) collapse to the last one, matching how the Loader resolves a
 * repeated namespace; a warning names the server but never a value.
 */
export function collectMcpServers(
  entries: readonly ConfigEntryRecord[],
  options: McpCollectOptions = {},
): McpCollectResult {
  const warnings = options.warnings ?? []
  const byId = new Map<string, McpServerRecord>()

  for (const entry of entries) {
    if (!isMcpEntry(entry)) continue
    const record = buildServerRecord(entry)
    if (record === null) {
      warnings.push(`跳过一个无法命名的 MCP 条目 / skipped an MCP entry with no server name: ${entry.id}`)
      continue
    }
    const existing = byId.get(record.id)
    if (existing !== undefined) {
      warnings.push(
        `MCP 服务 ${record.serverName} 被多次声明，采用最后一个 / MCP server ${record.serverName} is declared more than once; the last declaration wins`,
      )
    }
    byId.set(record.id, record)
  }

  const servers = [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { servers, warnings }
}
