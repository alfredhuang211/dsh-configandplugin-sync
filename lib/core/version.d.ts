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
    parts: string[];
    /** Pre-release segments, ordered before the release they belong to. */
    prerelease: string[];
}
/** Parse a version string; returns null when it carries no comparable content. */
export declare function parseVersion(value: string | null | undefined): ParsedVersion | null;
/**
 * Compare two version strings.
 * @returns negative when `left < right`, positive when `left > right`, 0 when equal.
 */
export declare function compareVersions(left: string | null | undefined, right: string | null | undefined): number;
/** Whether two versions are the same, treating an unknown version as "not equal". */
export declare function sameVersion(left: string | null | undefined, right: string | null | undefined): boolean;
export {};
