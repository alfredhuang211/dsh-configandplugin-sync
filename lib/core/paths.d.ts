/**
 * Filesystem path helpers shared by the collectors and the plugin entry.
 * @module core/paths
 */
/** Resolve the DSH home from the environment or the running profile. */
export declare function resolveDshHome(profileDir: string | undefined): string;
/** Resolve the active profile name from the profile context, environment or path. */
export declare function resolveProfileName(profileName: string | undefined, profileDir: string | undefined): string;
/** Render a path with the home directory abbreviated, for display only. */
export declare function displayPath(path: string): string;
/** Join a base directory and a store-relative POSIX path. */
export declare function joinStorePath(base: string, relativePath: string): string;
/**
 * Normalize a store-relative path and refuse anything that could escape the
 * store root: a `..` segment, an absolute path, a backslash, or an empty name.
 */
export declare function normalizeStorePath(path: string): string;
/** Whether `child` is inside `parent` after resolution. */
export declare function isInside(parent: string, child: string): boolean;
/** A filesystem-safe token from an arbitrary id (for file names). */
export declare function safeFileToken(value: string, maxLength?: number): string;
