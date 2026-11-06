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
import type { ConfigEntryRecord, PluginRecord, SyncLogger } from '../types.js';
/** One patch entry the inventory fallback may turn into a record. */
export interface PatchEntryRef {
    id: string;
    name?: string;
    disabled?: boolean;
}
/** Options of {@link collectPlugins}. */
export interface PluginsCollectOptions {
    /** Profile name stamped into every record. */
    profile: string;
    /** Absolute profile directory; null when it could not be resolved. */
    profileDir: string | null;
    /** Profile dependency map (`package.json` `dependencies`). */
    dependencies: Record<string, string>;
    /** Parsed entries, used for enablement and patch-only plugins. */
    entries?: readonly ConfigEntryRecord[];
    /** `ctx.pluginManager`, feature-detected by the caller. */
    pluginManager?: unknown;
    /** `process.platform`, stamped into every record. */
    platform?: string;
    /** Logger for non-fatal problems. */
    logger?: SyncLogger;
    /** Aborted when the caller cancels collection. */
    signal?: AbortSignal;
}
/** Result of scanning one profile's plugin inventory. */
export interface PluginsCollectResult {
    plugins: PluginRecord[];
    warnings: string[];
    /** Which source produced the records. */
    source: 'plugin-manager' | 'profile-manifest';
}
/** Parse a GitHub remote URL into `owner/repo`, or null for anything else. */
export declare function parseGithubRemote(url: string): {
    owner: string;
    repo: string;
} | null;
/** Facts about a local git checkout of a plugin. */
export interface CheckoutFacts {
    /** Repository root (the directory holding `.git`). */
    root: string;
    /** Plugin directory relative to the root, POSIX style ('' for a root package). */
    relativeDir: string;
    /** Raw remote URL of `origin` (or the first remote). */
    remoteUrl: string | null;
    /** GitHub coordinates, when the remote is on github.com. */
    github: {
        owner: string;
        repo: string;
    } | null;
    /** HEAD commit, or null when the checkout has no commit. */
    commit: string | null;
    /** Current branch, or null when detached. */
    branch: string | null;
    /** Whether HEAD is contained in the remote-tracking branch (i.e. pushed). */
    pushed: boolean;
    /** Whether the package's `main` file exists in the committed tree. */
    hasMain: boolean;
    /** Whether the repository root is itself this package (not a monorepo). */
    rootPackage: boolean;
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
export declare function inspectCheckout(pluginDir: string, options: {
    packageName: string;
    mainFile?: string | undefined;
}): Promise<CheckoutFacts | null>;
/**
 * Turn a local plugin checkout into a GitHub install spec, when that is honest.
 *
 * Conditions: the directory is a git checkout whose root package *is* the
 * plugin (a monorepo cannot be installed by repository spec), the remote is on
 * GitHub, HEAD is already pushed (otherwise the commit would not exist for the
 * other device), and the built entry point is committed (DSH's pnpm install
 * blocks build scripts, so a repository without `lib/` cannot work).
 */
export declare function resolveRestorableCheckout(name: string, localPath: string): Promise<{
    source: string;
    installSpec: string;
} | null>;
/**
 * Collect one profile's plugin inventory.
 *
 * Prefers the Host plugin manager and falls back to the profile manifest when
 * it is missing, throws, or returns nothing while dependencies exist. The
 * result is sorted by id so a snapshot is deterministic.
 */
export declare function collectPlugins(options: PluginsCollectOptions): Promise<PluginsCollectResult>;
