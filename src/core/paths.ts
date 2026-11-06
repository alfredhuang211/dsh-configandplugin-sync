/**
 * Filesystem path helpers shared by the collectors and the plugin entry.
 * @module core/paths
 */

import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Resolve the DSH home from the environment or the running profile. */
export function resolveDshHome(profileDir: string | undefined): string {
  const configured = (process.env.DSH_HOME ?? '').trim()
  if (configured !== '') return resolve(configured)
  const dir = (profileDir ?? '').trim()
  if (dir !== '') {
    // <home>/profiles/<name> → <home>
    return dirname(dirname(resolve(dir)))
  }
  return join(homedir(), '.dsh')
}

/** Resolve the active profile name from the profile context, environment or path. */
export function resolveProfileName(profileName: string | undefined, profileDir: string | undefined): string {
  const fromContext = (profileName ?? '').trim()
  if (fromContext !== '') return fromContext
  const fromEnv = (process.env.DSH_PROFILE ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const dir = (profileDir ?? '').trim()
  if (dir !== '') return basename(dir)
  return 'desktop'
}

/** Render a path with the home directory abbreviated, for display only. */
export function displayPath(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`
  return path
}

/** Join a base directory and a store-relative POSIX path. */
export function joinStorePath(base: string, relativePath: string): string {
  return join(base, ...relativePath.split('/'))
}

/**
 * Normalize a store-relative path and refuse anything that could escape the
 * store root: a `..` segment, an absolute path, a backslash, or an empty name.
 */
export function normalizeStorePath(path: string): string {
  const trimmed = path.replace(/^\/+/, '').trim()
  if (trimmed === '') throw new Error('empty store path')
  if (trimmed.includes('\\')) throw new Error(`invalid store path: ${path}`)
  if (trimmed.includes('\u0000')) throw new Error(`invalid store path: ${path}`)
  const segments: string[] = []
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new Error(`store path escapes the root: ${path}`)
    segments.push(segment)
  }
  if (segments.length === 0) throw new Error(`invalid store path: ${path}`)
  return segments.join('/')
}

/** Whether `child` is inside `parent` after resolution. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A filesystem-safe token from an arbitrary id (for file names). */
export function safeFileToken(value: string, maxLength = 64): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
  return cleaned === '' ? 'item' : cleaned
}
