/**
 * Plugin inventory collection.
 *
 * The inventory records *what is installed and how to reinstall it*, never the
 * plugin's code: no `node_modules` tree, no tarball, no local directory contents
 * are ever read — at most a plugin's own `package.json` for its version.
 *
 * `ctx.pluginManager` is the primary source because it also knows about
 * installation-provided bundles that the profile manifest does not list. When
 * it is absent or broken the profile's `package.json` dependencies plus the
 * patch entry ids are the fallback: a degraded but useful inventory.
 *
 * A plugin that cannot be inspected is still listed, with `error` set; nothing
 * here throws for a single bad plugin.
 * @module collect/plugins
 */

import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PACKAGE_NAME } from '../constants.js'
import { readTextFile } from '../core/fs.js'
import { parseJson, asJsonObject } from '../core/json.js'
import { redactText, sanitizeUrl } from '../core/redact.js'
import type {
  DshBundleInfo,
  DshPluginInfo,
  DshPluginManager,
} from '../dsh.js'
import type {
  ConfigEntryRecord,
  PluginOrigin,
  PluginRecord,
  PluginRowRecord,
  SyncLogger,
} from '../types.js'

/** Conservative npm package-name pattern (also used to guard path reads). */
const NPM_NAME_PATTERN = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Exact-version spec: `1.2.3`, `v1.2.3`, `1.2.3-rc.1`. */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** npm dist-tag or wildcard, which is a pinned-looking but unpinned version. */
const NPM_TAG_SPEC = /^(?:latest|next|beta|alpha|rc|canary|stable|\*|x)$/i

/** npm version range (`^1.2.3`, `~1.2`, `>=2`, `1.x`). */
const NPM_RANGE_SPEC = /^(?:[\^~]|>=?|<=?|=)?\s*v?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/

/** One patch entry the inventory fallback may turn into a record. */
export interface PatchEntryRef {
  id: string
  name?: string
  disabled?: boolean
}

/** Options of {@link collectPlugins}. */
export interface PluginsCollectOptions {
  /** Profile name stamped into every record. */
  profile: string
  /** Absolute profile directory; null when it could not be resolved. */
  profileDir: string | null
  /** Profile dependency map (`package.json` `dependencies`). */
  dependencies: Record<string, string>
  /** Parsed entries, used for enablement and patch-only plugins. */
  entries?: readonly ConfigEntryRecord[]
  /** `ctx.pluginManager`, feature-detected by the caller. */
  pluginManager?: unknown
  /** `process.platform`, stamped into every record. */
  platform?: string
  /** Logger for non-fatal problems. */
  logger?: SyncLogger
  /** Aborted when the caller cancels collection. */
  signal?: AbortSignal
}

/** Result of scanning one profile's plugin inventory. */
export interface PluginsCollectResult {
  plugins: PluginRecord[]
  warnings: string[]
  /** Which source produced the records. */
  source: 'plugin-manager' | 'profile-manifest'
}

/** Normalized origin classification for one install spec. */
interface OriginInfo {
  origin: PluginOrigin
  /** Sanitized, storeable spec; never contains a URL password. */
  source?: string
  /** Reproducible install spec, or null when there is none. */
  installSpec: string | null
  /** Absolute local directory, display-only (never synchronized as code). */
  localPath?: string
}

/** Everything the record builders share while one profile is scanned. */
interface ScanContext {
  profile: string
  profileDir: string | null
  dependencies: Record<string, string>
  platform: string
  entries: readonly ConfigEntryRecord[]
}

/** Whether a value is any non-array object (Host DTOs may be class instances). */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read a trimmed non-empty string, or undefined. */
function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Strip a `file:` prefix. */
function stripFileProtocol(spec: string): string {
  return spec.replace(/^file:/i, '')
}

/** Whether a spec points at a tarball. */
function isTarballSpec(spec: string): boolean {
  const withoutQuery = stripFileProtocol(spec).split(/[?#]/)[0] ?? ''
  return /\.(?:tgz|tar\.gz)$/i.test(withoutQuery)
}

/** Whether a spec is a git source (scheme, scp-like, or GitHub shorthand). */
function isGitSpec(spec: string): boolean {
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec)) return true
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) return /^(?:https?|ssh|git|git\+https|git\+ssh|sftp):/i.test(spec)
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(spec)) return true
  if (/\.git(?:#.*)?$/i.test(spec)) return true
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#.*)?$/.test(spec)
}

/** Whether a spec is an explicit local path or local protocol. */
function isLocalSpec(spec: string): boolean {
  if (/^(?:file|link|workspace):/i.test(spec)) return true
  if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return true
  if (spec === '~' || spec.startsWith('~/') || spec.startsWith('~\\')) return true
  if (spec === '.' || spec === '..') return true
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('.\\') || spec.startsWith('..\\')) return true
  return !NPM_NAME_PATTERN.test(spec) && /[\\/]/.test(spec)
}

/** Whether a spec is a registry (npm) spec. */
function isNpmSpec(spec: string): boolean {
  if (NPM_NAME_PATTERN.test(spec)) return true
  if (NPM_RANGE_SPEC.test(spec) || NPM_TAG_SPEC.test(spec)) return true
  const separator = spec.lastIndexOf('@')
  if (separator > 0) {
    const name = spec.slice(0, separator)
    const version = spec.slice(separator + 1)
    if (NPM_NAME_PATTERN.test(name) && (EXACT_VERSION.test(version) || NPM_TAG_SPEC.test(version))) return true
  }
  return false
}

/** Whether a git/tarball URL embeds a userinfo password. */
function hasUrlCredentials(spec: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i.test(spec)
}

/** A source string safe to show and store. */
function sanitizeSource(spec: string): string {
  if (hasUrlCredentials(spec)) return sanitizeUrl(spec)
  return redactText(spec)
}

/** Classify a git source. */
function classifyGit(spec: string): OriginInfo {
  const credentialed = hasUrlCredentials(spec)
  return {
    origin: 'git',
    source: sanitizeSource(spec),
    installSpec: credentialed ? null : spec,
  }
}

/** Classify a tarball source. */
function classifyTarball(spec: string, profileDir: string | null): OriginInfo {
  const path = stripFileProtocol(spec)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    const credentialed = hasUrlCredentials(path)
    return {
      origin: 'tarball',
      source: sanitizeSource(path),
      installSpec: credentialed ? null : path,
    }
  }
  const expanded = path.replace(/^~(?=$|[\\/])/, process.env['HOME'] ?? '~')
  if (isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) {
    return { origin: 'tarball', installSpec: null, localPath: resolve(expanded) }
  }
  return { origin: 'tarball', source: path, installSpec: path }
}

/** Classify a local path/protocol. */
function classifyLocal(spec: string, profileDir: string | null): OriginInfo {
  if (/^workspace:/i.test(spec)) return { origin: 'local-path', installSpec: null }
  const pathPart = stripFileProtocol(spec)
  const expanded = pathPart.replace(/^~(?=$|[\\/])/, process.env['HOME'] ?? '~')
  const absolute = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
  const localPath =
    absolute
      ? resolve(expanded)
      : profileDir !== null
        ? resolve(profileDir, expanded)
        : undefined
  const info: OriginInfo = { origin: 'local-path', installSpec: null }
  // A `link:`/`file:` spec is itself the storeable source; a bare absolute path
  // is not, because it names a directory on this device only.
  if (/^(?:link|file|workspace):/i.test(spec)) info.source = sanitizeSource(spec)
  else if (spec.startsWith('~') || spec.startsWith('./') || spec.startsWith('../')) info.source = spec
  if (localPath !== undefined) info.localPath = localPath
  return info
}

/** Classify one install source spec; a linked directory always means local-path. */
function classifySource(
  specInput: unknown,
  options: { linkedDir: string | null; profileDir: string | null },
): OriginInfo {
  if (options.linkedDir !== null) {
    return { origin: 'local-path', installSpec: null, localPath: options.linkedDir }
  }
  const spec = safeText(specInput)
  if (spec === undefined) return { origin: 'unknown', installSpec: null }
  if (isTarballSpec(spec)) return classifyTarball(spec, options.profileDir)
  if (isGitSpec(spec)) return classifyGit(spec)
  if (isLocalSpec(spec)) return classifyLocal(spec, options.profileDir)
  if (isNpmSpec(spec)) return { origin: 'npm', installSpec: null }
  return { origin: 'unknown', installSpec: null }
}

/** Resolve a dependency to a symlink target inside the profile's node_modules. */
async function resolveLinkedPackage(profileDir: string | null, name: string): Promise<string | null> {
  if (profileDir === null || !NPM_NAME_PATTERN.test(name)) return null
  const candidate = join(profileDir, 'node_modules', name)
  try {
    const info = await lstat(candidate)
    if (!info.isSymbolicLink()) return null
    try {
      return await realpath(candidate)
    } catch {
      return null
    }
  } catch {
    return null
  }
}

/** Read a plugin's installed version from its own `package.json` only. */
async function readInstalledVersion(context: ScanContext, name: string, localPath: string | undefined): Promise<string | null> {
  const candidates: string[] = []
  if (localPath !== undefined) candidates.push(join(localPath, 'package.json'))
  if (context.profileDir !== null && NPM_NAME_PATTERN.test(name)) {
    candidates.push(join(context.profileDir, 'node_modules', name, 'package.json'))
  }
  for (const file of candidates) {
    const text = await readTextFile(file)
    if (text === null) continue
    const parsed = asJsonObject(parseJson<unknown>(text))
    if (parsed === null) continue
    const version = safeText(parsed['version'])
    if (version !== undefined) return version
  }
  return null
}

/** Compute the reproducible install spec for one record. */
function resolveInstallSpec(name: string, origin: OriginInfo, version: string | null): string | null {
  if (origin.origin === 'npm') {
    return version !== null && EXACT_VERSION.test(version) ? `${name}@${version}` : null
  }
  if (origin.origin === 'git' || origin.origin === 'tarball') return origin.installSpec
  return null
}

/** Whether the plugin may be synchronized from this device at all. */
function computeSyncable(args: {
  builtIn: boolean
  name: string
  origin: PluginOrigin
  installSpec: string | null
}): boolean {
  if (args.builtIn) return false
  // The sync tool never backs itself up into its own store: restoring it on a
  // device that has deliberately not installed it would be surprising.
  if (args.name === PACKAGE_NAME) return false
  if (args.name.startsWith('cordis:')) return false
  // Local plugins synchronize as metadata only (their code is never copied), so
  // the other device can at least see what is missing.
  if (args.origin === 'local-path') return true
  if (args.origin === 'official' || args.origin === 'unknown') return false
  return args.installSpec !== null
}

/** Read a localized `meta.title`. */
function titleOf(meta: unknown): string | undefined {
  if (!isRecordObject(meta)) return undefined
  const title = meta['title']
  const direct = safeText(title)
  if (direct !== undefined) return direct
  if (!isRecordObject(title)) return undefined
  const english = safeText(title['en'])
  if (english !== undefined) return english
  for (const value of Object.values(title)) {
    const text = safeText(value)
    if (text !== undefined) return text
  }
  return undefined
}

/** Find the plugin info row that corresponds to one bundle row. */
function findPluginInfo(
  plugins: readonly DshPluginInfo[],
  query: { moduleName: string; entryId?: string; patchId?: string },
): DshPluginInfo | null {
  let byModule: DshPluginInfo | null = null
  for (const plugin of plugins) {
    const entryId = safeText(plugin.entryId)
    const moduleName = safeText(plugin.moduleName)
    if (query.entryId !== undefined && entryId === query.entryId) return plugin
    if (query.patchId !== undefined && safeText(plugin.patchId) === query.patchId && moduleName === query.moduleName) {
      return plugin
    }
    if (moduleName === query.moduleName && byModule === null) byModule = plugin
  }
  return byModule
}

/** Build the `rows` of one bundle, taking per-row enablement from the plugin list. */
function buildRows(bundle: DshBundleInfo, plugins: readonly DshPluginInfo[]): PluginRowRecord[] {
  const rows: PluginRowRecord[] = []
  const bundleName = safeText(bundle.name) ?? ''
  const rawRows = Array.isArray(bundle.rows) ? bundle.rows : []
  for (const rawRow of rawRows) {
    if (!isRecordObject(rawRow)) continue
    const moduleName = safeText(rawRow['moduleName'])
    if (moduleName === undefined) continue
    const rowId = safeText(rawRow['rowId'])
    const declaredEntryId = safeText(rawRow['entryId'])
    const match = findPluginInfo(plugins, { moduleName, ...(declaredEntryId === undefined ? {} : { entryId: declaredEntryId }), ...(rowId === undefined ? {} : { patchId: rowId }) })
    const row: PluginRowRecord = {
      moduleName,
      enabled: typeof match?.enabled === 'boolean' ? match.enabled : bundle.enabled === true,
    }
    if (declaredEntryId !== undefined) row.entryId = declaredEntryId
    else {
      const matchedEntryId = match === null ? undefined : safeText(match.entryId)
      if (matchedEntryId !== undefined) row.entryId = matchedEntryId
    }
    if (rowId !== undefined) row.rowId = rowId
    rows.push(row)
  }
  if (rows.length === 0) {
    for (const plugin of plugins) {
      if (safeText(plugin.moduleName) !== bundleName) continue
      const row: PluginRowRecord = { moduleName: bundleName, enabled: plugin.enabled === true }
      const entryId = safeText(plugin.entryId)
      if (entryId !== undefined) row.entryId = entryId
      rows.push(row)
    }
  }
  return rows
}

/** Human-readable error for a bundle the Host could not fully load. */
function bundleErrorText(bundle: DshBundleInfo): string | undefined {
  if (isRecordObject(bundle.error)) {
    const code = safeText(bundle.error['code']) ?? 'unknown error'
    const diagnostic = safeText(bundle.error['diagnostic'])
    return diagnostic === undefined ? code : redactText(`${code}: ${diagnostic}`)
  }
  const readOnlyReason = safeText(bundle.readOnlyReason)
  if (readOnlyReason !== undefined) return redactText(readOnlyReason)
  if (bundle.availability === 'missing') return 'not installed'
  return undefined
}

const execFileAsync = promisify(execFile)

/** Run one git command, returning null on any failure (git may be absent). */
async function gitText(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    })
    return result.stdout
  } catch {
    return null
  }
}

/** Parse a GitHub remote URL into `owner/repo`, or null for anything else. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim()
  if (trimmed === '') return null
  // https://github.com/owner/repo(.git) | git@github.com:owner/repo(.git) | ssh://git@github.com/owner/repo
  const match = /(?:^|@|\/\/)github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (match === null) return null
  const owner = match[1] ?? ''
  const repo = match[2] ?? ''
  if (owner === '' || repo === '') return null
  return { owner, repo }
}

/** Facts about a local git checkout of a plugin. */
export interface CheckoutFacts {
  /** Repository root (the directory holding `.git`). */
  root: string
  /** Plugin directory relative to the root, POSIX style ('' for a root package). */
  relativeDir: string
  /** Raw remote URL of the remote that carries HEAD (prefers `origin`, then the first). */
  remoteUrl: string | null
  /** GitHub coordinates, when the remote is on github.com. */
  github: { owner: string; repo: string } | null
  /** HEAD commit, or null when the checkout has no commit. */
  commit: string | null
  /** Current branch, or null when detached. */
  branch: string | null
  /** Whether HEAD is contained in the remote-tracking branch (i.e. pushed). */
  pushed: boolean
  /** Whether the package's `main` file exists in the committed tree. */
  hasMain: boolean
  /** Whether the repository root is itself this package (not a monorepo). */
  rootPackage: boolean
}

/**
 * Inspect a local directory as a git checkout of a plugin.
 *
 * This is what lets a `link:`-installed plugin that is really a clean GitHub
 * checkout become restorable on another device: the inventory records
 * `github:owner/repo#<commit>` instead of "a directory on this machine".
 * Nothing is installed and no network call is made — only local git state and
 * the committed tree are read.
 */
export async function inspectCheckout(
  pluginDir: string,
  options: { packageName: string; mainFile?: string | undefined },
): Promise<CheckoutFacts | null> {
  let root = resolve(pluginDir)
  let found = false
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const info = await lstat(join(root, '.git'))
      if (info.isDirectory() || info.isFile()) {
        found = true
        break
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  if (!found) return null

  const relativeDir = resolve(pluginDir) === root ? '' : resolve(pluginDir).slice(root.length + 1).split(/[\\/]/).join('/')
  const remotes = (await gitText(root, ['remote']))?.split('\n').map(line => line.trim()).filter(line => line !== '') ?? []
  const commit = (await gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() ?? null
  if (commit === null || commit === '') return null
  const branchRaw = (await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? ''
  const branch = branchRaw === '' || branchRaw === 'HEAD' ? null : branchRaw

  /**
   * Pick the remote that actually carries this commit.
   *
   * A checkout can have several remotes — the common shape here is `origin`
   * pointing at the upstream project and a personal remote (say `github`)
   * pointing at the user's fork. Choosing `origin` blindly would advertise the
   * upstream URL for a commit it does not even contain. The remote whose
   * tracking branch contains HEAD is the right source, and it doubles as the
   * proof that the commit is published.
   */
  let pushed = false
  let remoteUrl: string | null = null
  const candidates: Array<{ name: string; url: string; contains: boolean }> = []
  for (const name of remotes) {
    const url = (await gitText(root, ['remote', 'get-url', name]))?.trim() ?? ''
    if (url === '') continue
    let contains = false
    if (branch !== null) {
      const upstream = (await gitText(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}/${branch}`]))?.trim() ?? ''
      if (upstream !== '') {
        try {
          await execFileAsync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, upstream], { timeout: 10_000 })
          contains = true
        } catch {
          contains = false
        }
      }
    }
    candidates.push({ name, url, contains })
  }
  const chosen =
    candidates.find(candidate => candidate.contains && candidate.name === 'origin') ??
    candidates.find(candidate => candidate.contains) ??
    candidates.find(candidate => candidate.name === 'origin') ??
    candidates[0]
  if (chosen !== undefined) {
    remoteUrl = chosen.url
    pushed = chosen.contains
  }

  const mainFile = options.mainFile ?? 'lib/index.js'
  const mainPath = relativeDir === '' ? mainFile : `${relativeDir}/${mainFile}`
  let hasMain = false
  try {
    await execFileAsync('git', ['-C', root, 'cat-file', '-e', `${commit}:${mainPath}`], { timeout: 10_000 })
    hasMain = true
  } catch {
    hasMain = false
  }

  let rootPackage = false
  if (relativeDir === '') {
    const manifest = parseJson<{ name?: unknown; private?: unknown }>((await readTextFile(join(root, 'package.json'))) ?? '')
    rootPackage =
      manifest !== null && manifest.name === options.packageName && manifest.private !== true
  }

  return {
    root,
    relativeDir,
    remoteUrl,
    github: remoteUrl === null ? null : parseGithubRemote(remoteUrl),
    commit,
    branch,
    pushed,
    hasMain,
    rootPackage,
  }
}

/** Build the common tail of a record from its origin and version facts. */
async function finalizeRecord(args: {
  id: string
  name: string
  version: string | null
  originInfo: OriginInfo
  enabled: boolean
  builtIn: boolean
  rows: PluginRowRecord[]
  context: ScanContext
  displayName?: string | undefined
  error?: string | undefined
}): Promise<PluginRecord> {
  const installSpec = resolveInstallSpec(args.name, args.originInfo, args.version)
  const record: PluginRecord = {
    id: args.id,
    name: args.name,
    version: args.version,
    origin: args.originInfo.origin,
    installSpec,
    enabled: args.enabled,
    builtIn: args.builtIn,
    syncable: computeSyncable({
      builtIn: args.builtIn,
      name: args.name,
      origin: args.originInfo.origin,
      installSpec,
    }),
    restorable: !args.builtIn && args.originInfo.origin !== 'local-path' && args.originInfo.origin !== 'unknown' && installSpec !== null,
    profile: args.context.profile,
    platform: args.context.platform,
    rows: args.rows,
  }
  if (args.displayName !== undefined) record.displayName = args.displayName
  if (args.originInfo.source !== undefined) record.source = args.originInfo.source
  if (args.error !== undefined) record.error = redactText(args.error)

  // A `link:` plugin that is really a clean GitHub checkout can be restored on
  // another device from that repository; record the reproducible spec instead
  // of "a directory on this machine".
  if (!args.builtIn && args.originInfo.origin === 'local-path' && args.originInfo.localPath !== undefined) {
    const checkout = await resolveRestorableCheckout(args.name, args.originInfo.localPath)
    if (checkout !== null) {
      record.origin = 'git'
      record.source = checkout.source
      record.installSpec = checkout.installSpec
      record.restorable = true
      record.syncable = true
      record.id = args.name
    }
  }
  return record
}

/**
 * Turn a local plugin checkout into a GitHub install spec, when that is honest.
 *
 * Conditions: the directory is a git checkout whose root package *is* the
 * plugin (a monorepo cannot be installed by repository spec), the remote is on
 * GitHub, HEAD is already pushed (otherwise the commit would not exist for the
 * other device), and the built entry point is committed (DSH's pnpm install
 * blocks build scripts, so a repository without `lib/` cannot work).
 */
export async function resolveRestorableCheckout(
  name: string,
  localPath: string,
): Promise<{ source: string; installSpec: string } | null> {
  const manifest = parseJson<{ name?: unknown; main?: unknown; module?: unknown }>(
    (await readTextFile(join(localPath, 'package.json'))) ?? '',
  )
  // The directory must really be this package; a stray checkout of some other
  // project must never be advertised as the plugin's source.
  if (manifest === null || manifest.name !== name) return null
  const mainFile =
    typeof manifest.main === 'string' && manifest.main.trim() !== ''
      ? manifest.main.trim()
      : typeof manifest.module === 'string' && manifest.module.trim() !== ''
        ? manifest.module.trim()
        : 'lib/index.js'
  const facts = await inspectCheckout(localPath, { packageName: name, mainFile })
  if (facts === null || facts.github === null) return null
  if (!facts.pushed || !facts.hasMain) return null
  const slug = `${facts.github.owner}/${facts.github.repo}`

  // A single-package repository installs by repository spec. A package inside a
  // monorepo installs from the same repository plus pnpm's `&path:` selector,
  // which is how a workspace plugin stays reproducible without a second repo.
  if (facts.rootPackage) {
    return {
      source: facts.branch === null ? `github:${slug}` : `github:${slug}#${facts.branch}`,
      installSpec: `github:${slug}#${facts.commit}`,
    }
  }
  if (facts.relativeDir === '' || !/^[A-Za-z0-9._\/-]+$/.test(facts.relativeDir)) return null
  const subPath = `&path:/${facts.relativeDir}`
  return {
    source: facts.branch === null ? `github:${slug}${subPath}` : `github:${slug}#${facts.branch}${subPath}`,
    installSpec: `github:${slug}#${facts.commit}${subPath}`,
  }
}

/** Build one record from a plugin-manager bundle row. */
async function buildBundleRecord(
  bundle: DshBundleInfo,
  plugins: readonly DshPluginInfo[],
  context: ScanContext,
): Promise<PluginRecord | null> {
  const name = safeText(bundle.name)
  if (name === undefined) return null
  const builtIn = bundle.official === true || bundle.availability === 'installation' || name.startsWith('@deepseek-ai/')
  if (bundle.installed === false && builtIn === false) return null

  const installTarget = isRecordObject(bundle.installTarget) ? bundle.installTarget : null
  const installTargetSpec = installTarget === null ? undefined : safeText(installTarget['spec'])
  const dependencySpec = context.dependencies[name]
  const linkedDir = builtIn ? null : await resolveLinkedPackage(context.profileDir, name)
  const originInfo: OriginInfo = builtIn
    ? { origin: 'official', installSpec: null }
    : classifySource(installTargetSpec ?? safeText(bundle.source) ?? dependencySpec ?? safeText(bundle.version), {
        linkedDir,
        profileDir: context.profileDir,
      })

  const bundleVersion = safeText(bundle.version)
  const installTargetVersion = installTarget === null ? undefined : safeText(installTarget['version'])
  const dependencyVersion =
    dependencySpec !== undefined && EXACT_VERSION.test(dependencySpec.trim()) ? dependencySpec.trim() : null
  let version: string | null = bundleVersion ?? installTargetVersion ?? null
  if (version === null && !builtIn) {
    version =
      originInfo.origin === 'local-path'
        ? (await readInstalledVersion(context, name, originInfo.localPath)) ?? dependencyVersion
        : dependencyVersion ?? (await readInstalledVersion(context, name, originInfo.localPath))
  }
  const id = originInfo.origin === 'local-path' ? `local:${name}` : name
  const displayName = titleOf(bundle.meta) ?? titleOf(findPluginInfo(plugins, { moduleName: name })?.meta)
  return await finalizeRecord({
    id,
    name,
    version,
    originInfo,
    enabled: bundle.enabled === true,
    builtIn,
    rows: buildRows(bundle, plugins),
    context,
    displayName,
    error: bundleErrorText(bundle),
  })
}

/** Build one record for a plugin entry that no bundle claims (an orphan). */
async function buildOrphanRecord(plugin: DshPluginInfo, context: ScanContext): Promise<PluginRecord | null> {
  const moduleName = safeText(plugin.moduleName)
  const entryId = safeText(plugin.entryId)
  const name = moduleName ?? entryId
  if (name === undefined) return null
  const builtIn = name.startsWith('@deepseek-ai/') || name.startsWith('cordis:')
  const dependencySpec = context.dependencies[name]
  const linkedDir = builtIn ? null : await resolveLinkedPackage(context.profileDir, name)
  const originInfo: OriginInfo = builtIn
    ? { origin: 'official', installSpec: null }
    : classifySource(dependencySpec, { linkedDir, profileDir: context.profileDir })
  const dependencyVersion =
    dependencySpec !== undefined && EXACT_VERSION.test(dependencySpec.trim()) ? dependencySpec.trim() : null
  const version = builtIn
    ? null
    : dependencyVersion ?? (await readInstalledVersion(context, name, originInfo.localPath))
  const row: PluginRowRecord = { moduleName: name, enabled: plugin.enabled === true }
  if (entryId !== undefined) row.entryId = entryId
  return await finalizeRecord({
    id: originInfo.origin === 'local-path' ? `local:${name}` : name,
    name,
    version,
    originInfo,
    enabled: plugin.enabled === true,
    builtIn,
    rows: [row],
    context,
    displayName: titleOf(plugin.meta),
    error: 'no matching bundle metadata was found for this plugin entry',
  })
}

/** Build records from plugin-manager bundles, then add bundle-less orphan rows. */
async function buildFromManager(
  bundles: readonly unknown[],
  plugins: readonly unknown[],
  context: ScanContext,
): Promise<PluginRecord[]> {
  const pluginInfos = plugins.filter((plugin): plugin is DshPluginInfo => isRecordObject(plugin))
  const records: PluginRecord[] = []
  const covered = new Set<string>()
  for (const bundle of bundles) {
    if (!isRecordObject(bundle)) continue
    const record = await buildBundleRecord(bundle as unknown as DshBundleInfo, pluginInfos, context)
    if (record === null) continue
    records.push(record)
    covered.add(record.name)
    for (const row of record.rows) covered.add(row.moduleName)
  }
  for (const plugin of pluginInfos) {
    const moduleName = safeText(plugin.moduleName)
    if (moduleName !== undefined && covered.has(moduleName)) continue
    const orphan = await buildOrphanRecord(plugin, context)
    if (orphan === null) continue
    if (covered.has(orphan.name)) continue
    covered.add(orphan.name)
    records.push(orphan)
  }
  return records
}

/** Patch entries that carry a module name, keyed by that module name. */
function entriesByModule(entries: readonly ConfigEntryRecord[]): Map<string, ConfigEntryRecord[]> {
  const byModule = new Map<string, ConfigEntryRecord[]>()
  for (const entry of entries) {
    const name = entry.name
    if (name === undefined) continue
    const list = byModule.get(name)
    if (list === undefined) byModule.set(name, [entry])
    else list.push(entry)
  }
  return byModule
}

/** Build the `rows` of a manifest record from the entries that declare it. */
function rowsFromEntries(name: string, entries: readonly ConfigEntryRecord[]): PluginRowRecord[] {
  const rows: PluginRowRecord[] = []
  for (const entry of entries) {
    if (entry.name !== name) continue
    const row: PluginRowRecord = { moduleName: name, enabled: entry.disabled !== true }
    row.entryId = entry.id
    row.rowId = entry.patchId ?? entry.id
    rows.push(row)
  }
  return rows
}

/** Build records from a profile package.json: the degraded fallback path. */
async function buildFromProfileManifest(context: ScanContext): Promise<PluginRecord[]> {
  const records: PluginRecord[] = []
  const byModule = entriesByModule(context.entries)
  for (const [name, spec] of Object.entries(context.dependencies)) {
    const trimmed = name.trim()
    if (trimmed === '') continue
    const builtIn = trimmed.startsWith('@deepseek-ai/') || trimmed.startsWith('cordis:')
    const linkedDir = builtIn ? null : await resolveLinkedPackage(context.profileDir, trimmed)
    const originInfo: OriginInfo = builtIn
      ? { origin: 'official', installSpec: null }
      : classifySource(spec, { linkedDir, profileDir: context.profileDir })
    const dependencyVersion = EXACT_VERSION.test(spec.trim()) ? spec.trim() : null
    const version =
      dependencyVersion ?? (await readInstalledVersion(context, trimmed, originInfo.localPath))
    const rows = rowsFromEntries(trimmed, context.entries)
    // The manifest does not record enablement; a patch row that disables every
    // declaration of the module is the only local evidence of "off".
    const enabled = rows.length === 0 ? true : rows.some(row => row.enabled)
    if (rows.length === 0) rows.push({ moduleName: trimmed, enabled: true })
    records.push(
      await finalizeRecord({
        id: originInfo.origin === 'local-path' ? `local:${trimmed}` : trimmed,
        name: trimmed,
        version,
        originInfo,
        enabled,
        builtIn,
        rows,
        context,
      }),
    )
  }

  // Patch entries that no dependency covers: a plugin inserted directly into a
  // patch file, or a `file:` plugin the user loaded by path. Official modules
  // are skipped because their rows belong to a bundle, not to an install.
  const covered = new Set(Object.keys(context.dependencies))
  for (const entry of context.entries) {
    const name = entry.name
    if (name === undefined || name === '' || covered.has(name)) continue
    if (name.startsWith('@deepseek-ai/') || name.startsWith('cordis:')) continue
    covered.add(name)
    const linkedDir = await resolveLinkedPackage(context.profileDir, name)
    const originInfo: OriginInfo = classifySource(name, { linkedDir, profileDir: context.profileDir })
    const version = await readInstalledVersion(context, name, originInfo.localPath)
    records.push(
      await finalizeRecord({
        id: originInfo.origin === 'local-path' ? `local:${name}` : name,
        name,
        version,
        originInfo,
        enabled: entry.disabled !== true,
        builtIn: false,
        rows: rowsFromEntries(name, context.entries),
        context,
      }),
    )
  }
  return records
}

/** Merge records observed twice (same id) without losing rows or metadata. */
function dedupeRecords(records: readonly PluginRecord[]): PluginRecord[] {
  const byId = new Map<string, PluginRecord>()
  for (const record of records) {
    const existing = byId.get(record.id)
    if (existing === undefined) {
      byId.set(record.id, record)
      continue
    }
    for (const row of record.rows) {
      const duplicate = existing.rows.some(
        candidate => candidate.moduleName === row.moduleName && candidate.entryId === row.entryId,
      )
      if (!duplicate) existing.rows.push(row)
    }
    if (existing.version === null && record.version !== null) existing.version = record.version
    if (existing.installSpec === null && record.installSpec !== null) existing.installSpec = record.installSpec
    if (existing.displayName === undefined && record.displayName !== undefined) existing.displayName = record.displayName
    if (existing.source === undefined && record.source !== undefined) existing.source = record.source
    if (existing.error === undefined && record.error !== undefined) existing.error = record.error
    existing.syncable = existing.syncable || record.syncable
    existing.restorable = existing.restorable || record.restorable
  }
  return [...byId.values()]
}

/** Whether the plugin manager can be used at all. */
function usableManager(manager: unknown): DshPluginManager | null {
  if (!isRecordObject(manager)) return null
  const listBundles = manager['listBundles']
  const listPlugins = manager['listPlugins']
  if (typeof listBundles !== 'function' && typeof listPlugins !== 'function') return null
  return manager as unknown as DshPluginManager
}

/**
 * Collect one profile's plugin inventory.
 *
 * Prefers the Host plugin manager and falls back to the profile manifest when
 * it is missing, throws, or returns nothing while dependencies exist. The
 * result is sorted by id so a snapshot is deterministic.
 */
export async function collectPlugins(options: PluginsCollectOptions): Promise<PluginsCollectResult> {
  const warnings: string[] = []
  const context: ScanContext = {
    profile: options.profile,
    profileDir: options.profileDir,
    dependencies: options.dependencies,
    platform: options.platform ?? process.platform,
    entries: options.entries ?? [],
  }
  const logWarn = (message: string): void => {
    warnings.push(message)
    try {
      options.logger?.warn(message)
    } catch {
      // Logging must never break collection.
    }
  }

  const manager = usableManager(options.pluginManager)
  let records: PluginRecord[] | null = null
  if (manager !== null) {
    try {
      const [bundlesRaw, pluginsRaw] = await Promise.all([
        typeof manager.listBundles === 'function' ? manager.listBundles() : Promise.resolve([]),
        typeof manager.listPlugins === 'function' ? manager.listPlugins() : Promise.resolve([]),
      ])
      throwIfAborted(options.signal)
      records = await buildFromManager(
        Array.isArray(bundlesRaw) ? bundlesRaw : [],
        Array.isArray(pluginsRaw) ? pluginsRaw : [],
        context,
      )
    } catch (error) {
      if (isAbort(error)) throw error
      logWarn(`插件管理服务不可用，改用 profile 清单 / the plugin manager was unavailable; using the profile manifest`)
      records = null
    }
  }

  const useFallback = records === null || (records.length === 0 && Object.keys(context.dependencies).length > 0)
  let source: PluginsCollectResult['source'] = 'plugin-manager'
  if (useFallback) {
    source = 'profile-manifest'
    try {
      records = await buildFromProfileManifest(context)
    } catch (error) {
      if (isAbort(error)) throw error
      logWarn('无法从 profile 清单构建插件列表 / could not build the inventory from the profile manifest')
      records = records ?? []
    }
  }

  throwIfAborted(options.signal)
  const plugins = dedupeRecords(records ?? []).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { plugins, warnings, source }
}

/** Whether a thrown value is an abort. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))
}

/** Throw a cancellation error when the caller aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('plugin inventory collection was cancelled')
    error.name = 'AbortError'
    throw error
  }
}
