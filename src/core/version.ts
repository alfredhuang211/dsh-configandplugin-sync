/**
 * Version comparison.
 *
 * Deliberately tolerant: plugin versions in the wild are semver, calver, git
 * describe output, or a bare commit. One shared comparator keeps the engine's
 * "upgrade vs downgrade" decision consistent across every section.
 * @module core/version
 */

/** Parsed comparable version. */
interface ParsedVersion {
  /** Numeric and alphabetic segments, in order. */
  parts: string[]
  /** Pre-release segments, ordered before the release they belong to. */
  prerelease: string[]
}

/** Parse a version string; returns null when it carries no comparable content. */
export function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^v/i, '')
  if (trimmed === '') return null
  const plusIndex = trimmed.indexOf('+')
  const withoutBuild = plusIndex === -1 ? trimmed : trimmed.slice(0, plusIndex)
  const dashIndex = withoutBuild.indexOf('-')
  const core = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)
  const prerelease = dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split('.')
  const parts = core.split('.').filter(part => part !== '')
  if (parts.length === 0) return null
  return { parts, prerelease }
}

/**
 * Compare two version strings.
 * @returns negative when `left < right`, positive when `left > right`, 0 when equal.
 */
export function compareVersions(left: string | null | undefined, right: string | null | undefined): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  const length = Math.max(a.parts.length, b.parts.length)
  for (let index = 0; index < length; index += 1) {
    const comparison = compareSegment(a.parts[index], b.parts[index])
    if (comparison !== 0) return comparison
  }
  // A release outranks its own prereleases.
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1
  if (b.prerelease.length === 0 && a.prerelease.length > 0) return -1
  const preLength = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < preLength; index += 1) {
    const comparison = compareSegment(a.prerelease[index], b.prerelease[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

/** Compare one segment: numeric-aware, absent segments sort last as zero. */
function compareSegment(left: string | undefined, right: string | undefined): number {
  const a = left ?? '0'
  const b = right ?? '0'
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    const diff = Number(a) - Number(b)
    return diff === 0 ? 0 : diff > 0 ? 1 : -1
  }
  if (aNumeric) return -1
  if (bNumeric) return 1
  if (a === b) return 0
  return a > b ? 1 : -1
}

/** Whether two versions are the same, treating an unknown version as "not equal". */
export function sameVersion(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false
  return compareVersions(left, right) === 0
}
