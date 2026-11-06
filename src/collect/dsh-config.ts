/**
 * DSH configuration collection.
 *
 * A profile's configuration is captured as the *literal text* of the files the
 * Loader composes — the home patch, the profile patch, `cordis.yml` and the
 * profile `package.json` — plus the parsed, secret-free entries for the engine
 * to compare. The file text is the write path: a restore merges patch blocks
 * verbatim, so comments, ordering and `!!js` expressions survive a round trip
 * that re-serializing YAML would destroy.
 *
 * The parsed entries come from `ctx.configEditor` when the Host exposes it and
 * from {@link splitPatch} otherwise; the fallback recovers identity only, since
 * this plugin does not carry a YAML parser for patch files.
 *
 * Nothing here throws on a bad file: an unreadable or unparsable file becomes a
 * warning and the rest of the snapshot is still produced.
 * @module collect/dsh-config
 */

import { join, resolve } from 'node:path'
import {
  HOME_PATCH_FILE,
  PROFILE_CORDIS_FILE,
  PROFILE_PACKAGE_FILE,
  PROFILE_PATCH_FILE,
} from '../constants.js'
import { readTextFile } from '../core/fs.js'
import { SyncError } from '../core/errors.js'
import { sha256Text } from '../core/hash.js'
import { maskYamlSecrets } from '../core/redact.js'
import { parseJson, asJsonObject } from '../core/json.js'
import { redactText } from '../core/redact.js'
import { isInside } from '../core/paths.js'
import type {
  ConfigEntryRecord,
  ConfigFileKind,
  ConfigFileRecord,
  DshConfigRecord,
  SyncLogger,
} from '../types.js'
import { readRawEntries, toConfigEntryRecords } from './entries.js'

/** Conservative profile-name validation; also blocks path traversal. */
const SAFE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** One configuration file the collector knows how to locate. */
interface ConfigFileTarget {
  kind: ConfigFileKind
  /** Path relative to the DSH home, using `/`. */
  relativePath: string
  /** Absolute path on disk. */
  absolutePath: string
  /** Whether a missing file is worth a warning (the home patch is optional). */
  warnWhenMissing: boolean
}

/** Facts read out of the profile `package.json`. */
export interface ProfilePackageFacts {
  /** Dependency name → specifier. */
  dependencies: Record<string, string>
  /** Bundle names selected by the profile, in declared order. */
  bundles: string[]
}

/** Options of {@link collectDshConfig}. */
export interface DshConfigReadOptions {
  /** Absolute DSH home (`$DSH_HOME` or `~/.dsh`). */
  dshHome: string
  /** `<dshHome>/profiles`; defaults to `join(dshHome, 'profiles')`. */
  profilesRoot?: string
  /** Profile name (`desktop`). */
  profile: string
  /** `ctx.configEditor`, feature-detected by the caller. */
  configEditor?: unknown
  /** Logger for non-fatal problems; never receives configuration values. */
  logger?: SyncLogger
  /** Aborted when the caller cancels collection. */
  signal?: AbortSignal
}

/** Everything one profile's configuration read produced. */
export interface DshConfigReadResult {
  /** The `dsh-config` section value. */
  record: DshConfigRecord
  /** Absolute profile directory, or null when it cannot be resolved safely. */
  profileDir: string | null
  /** Profile dependency map, also mirrored into `record.dependencies`. */
  dependencies: Record<string, string>
  /** Bundle names, also mirrored into `record.bundles`. */
  bundles: string[]
  /** Where the parsed entries came from. */
  entriesSource: 'config-editor' | 'patch' | 'none'
}

/** Normalize a dependency map from untrusted JSON. */
function normalizeDependencies(value: unknown): Record<string, string> {
  const dependencies: Record<string, string> = {}
  const record = asJsonObject(value)
  if (record === null) return dependencies
  for (const [name, spec] of Object.entries(record)) {
    if (typeof spec !== 'string') continue
    const trimmedName = name.trim()
    const trimmedSpec = spec.trim()
    if (trimmedName === '' || trimmedSpec === '') continue
    dependencies[trimmedName] = trimmedSpec
  }
  return dependencies
}

/** Collect the bundle names a profile manifest declares under `dsh`. */
function normalizeBundles(value: unknown): string[] {
  const out: string[] = []
  const push = (item: unknown): void => {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
      return
    }
    const record = asJsonObject(item)
    if (record !== null) push(record['name'])
  }
  const dsh = asJsonObject(value)
  if (dsh === null) return out
  const profileSection = asJsonObject(dsh['profile'])
  const candidates: unknown[] = []
  if (profileSection !== null && Array.isArray(profileSection['bundles'])) {
    candidates.push(...(profileSection['bundles'] as unknown[]))
  }
  if (Array.isArray(dsh['bundles'])) candidates.push(...(dsh['bundles'] as unknown[]))
  if (Array.isArray(dsh['bundle'])) candidates.push(...(dsh['bundle'] as unknown[]))
  else if (dsh['bundle'] !== undefined) candidates.push(dsh['bundle'])
  for (const item of candidates) push(item)
  return out
}

/** Parse the text of a profile `package.json`; null when unusable. */
export function parseProfilePackage(text: string): ProfilePackageFacts | null {
  const parsed = parseJson<unknown>(text)
  const record = asJsonObject(parsed)
  if (record === null) return null
  return {
    dependencies: normalizeDependencies(record['dependencies']),
    bundles: normalizeBundles(record['dsh']),
  }
}

/** Resolve the profile directory, refusing a name that could escape the home. */
function resolveProfileDir(dshHome: string, profilesRoot: string, profile: string): string | null {
  const name = profile.trim()
  if (name === '' || !SAFE_PROFILE_NAME.test(name)) return null
  const dir = resolve(profilesRoot, name)
  if (!isInside(dshHome, dir)) return null
  return dir
}

/** Build the list of files to read for one profile. */
function configFileTargets(dshHome: string, profile: string, profileDir: string | null): ConfigFileTarget[] {
  const targets: ConfigFileTarget[] = [
    {
      kind: 'home-patch',
      relativePath: HOME_PATCH_FILE,
      absolutePath: join(dshHome, HOME_PATCH_FILE),
      warnWhenMissing: false,
    },
  ]
  if (profileDir === null) return targets
  const profileRoot = `profiles/${profile}`
  targets.push(
    {
      kind: 'profile-patch',
      relativePath: `${profileRoot}/${PROFILE_PATCH_FILE}`,
      absolutePath: join(profileDir, PROFILE_PATCH_FILE),
      warnWhenMissing: true,
    },
    {
      kind: 'profile-cordis',
      relativePath: `${profileRoot}/${PROFILE_CORDIS_FILE}`,
      absolutePath: join(profileDir, PROFILE_CORDIS_FILE),
      warnWhenMissing: true,
    },
    {
      kind: 'profile-package',
      relativePath: `${profileRoot}/${PROFILE_PACKAGE_FILE}`,
      absolutePath: join(profileDir, PROFILE_PACKAGE_FILE),
      warnWhenMissing: true,
    },
  )
  return targets
}

/**
 * Report files whose literal text appears to carry a plaintext credential.
 *
 * The record keeps the file text verbatim — that is what makes a restore
 * reproduce the user's configuration — so a credential the user hardcoded
 * there would otherwise reach the store without any signal. The warning names
 * the file and line numbers only: never the value, which is exactly the thing
 * being reported.
 */
function scanForPlaintextCredentials(target: ConfigFileTarget, content: string, warnings: string[]): void {
  const lines = content.split('\n')
  const hits: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (redactText(line) === line) continue
    hits.push(index + 1)
    if (hits.length >= 3) break
  }
  if (hits.length === 0) return
  warnings.push(
    `${target.relativePath} 第 ${hits.join(', ')} 行疑似明文密钥，建议改用环境变量或凭证存储 / ${target.relativePath} looks like it contains a plaintext credential at line ${hits.join(', ')}; prefer an environment variable or the credential store`,
  )
}

/**
 * Turn a file's literal text into a {@link ConfigFileRecord}.
 *
 * Patch files pass through {@link maskYamlSecrets} first: their text is
 * synchronized verbatim, so a credential the user hardcoded in one would
 * otherwise be uploaded in the clear. Masking keeps the document shape (and
 * therefore a faithful per-entry merge) while the value itself stays on this
 * device; a restore puts the local value back under the mask.
 */
function toFileRecord(target: ConfigFileTarget, content: string, warnings: string[]): ConfigFileRecord {
  let text = content
  if (target.kind === 'home-patch' || target.kind === 'profile-patch') {
    const masked = maskYamlSecrets(content)
    if (masked.masked.length > 0) {
      text = masked.text
      const keys = [...new Set(masked.masked.map(item => item.key))].slice(0, 5)
      warnings.push(
        `${target.relativePath} 中 ${masked.masked.length} 处敏感值已用 *** 标记，不会同步其内容（${keys.join(', ')}）/ ${masked.masked.length} secret value(s) in ${target.relativePath} are masked in the synchronized copy (${keys.join(', ')}); move them to the credential store to synchronize them safely`,
      )
    }
  }
  return {
    path: target.relativePath,
    kind: target.kind,
    sha256: sha256Text(text),
    size: Buffer.byteLength(text, 'utf8'),
    content: text,
  }
}

/**
 * Read one profile's whole DSH configuration.
 *
 * The result always has a valid {@link DshConfigRecord}: unreadable files,
 * an unsafe profile name or a malformed `package.json` are reported through
 * `record.warnings` instead of failing the collection.
 */
export async function collectDshConfig(options: DshConfigReadOptions): Promise<DshConfigReadResult> {
  const warnings: string[] = []
  const dshHome = resolve(options.dshHome)
  const profilesRoot = resolve(options.profilesRoot ?? join(dshHome, 'profiles'))
  const profile = options.profile.trim()
  const empty: DshConfigRecord = {
    profile,
    files: [],
    entries: [],
    bundles: [],
    dependencies: {},
    warnings,
  }

  if (profile === '') {
    warnings.push('未指定 DSH profile / no DSH profile was given')
    return { record: empty, profileDir: null, dependencies: {}, bundles: [], entriesSource: 'none' }
  }

  const profileDir = resolveProfileDir(dshHome, profilesRoot, profile)
  if (profileDir === null) {
    warnings.push(`profile 名称无效 / invalid profile name: ${profile}`)
  }

  const targets = configFileTargets(dshHome, profile, profileDir)
  const contents = new Map<ConfigFileKind, string>()
  const files: ConfigFileRecord[] = []
  for (const target of targets) {
    throwIfAborted(options.signal)
    let text: string | null
    try {
      text = await readTextFile(target.absolutePath)
    } catch {
      text = null
    }
    if (text === null) {
      if (target.warnWhenMissing) {
        warnings.push(`配置文件缺失或不可读 / configuration file is missing or unreadable: ${target.relativePath}`)
      }
      continue
    }
    contents.set(target.kind, text)
    files.push(toFileRecord(target, text, warnings))
    if (target.kind !== 'profile-cordis') scanForPlaintextCredentials(target, text, warnings)
  }

  // Bundles and dependencies come from the profile manifest; both are needed by
  // the plugin inventory even when this section is not being synchronized.
  let dependencies: Record<string, string> = {}
  let bundles: string[] = []
  const packageText = contents.get('profile-package')
  if (packageText !== undefined) {
    const facts = parseProfilePackage(packageText)
    if (facts === null) {
      warnings.push(`profile 的 package.json 无法解析 / the profile package.json could not be parsed`)
    } else {
      dependencies = facts.dependencies
      bundles = facts.bundles
    }
  }

  throwIfAborted(options.signal)

  // The config editor is the only source of parsed config values; the literal
  // patch files are the fallback source of entry identity.
  const read = readRawEntries({
    configEditor: options.configEditor,
    patchTexts: [contents.get('home-patch'), contents.get('profile-patch')],
    warnings,
  })
  const entries: ConfigEntryRecord[] = toConfigEntryRecords(read.entries, warnings)

  const record: DshConfigRecord = {
    profile,
    files,
    entries,
    bundles,
    dependencies,
    warnings,
  }

  try {
    options.logger?.debug('collected DSH configuration', {
      profile,
      files: files.length,
      entries: entries.length,
      entrySource: read.source,
    })
  } catch {
    // Logging must never break collection.
  }

  return { record, profileDir, dependencies, bundles, entriesSource: read.source }
}

/** Throw the cancellation error when the caller aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SyncError('cancelled', '配置采集已取消 / configuration collection was cancelled')
  }
}
