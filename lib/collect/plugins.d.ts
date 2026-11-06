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
/**
 * Collect one profile's plugin inventory.
 *
 * Prefers the Host plugin manager and falls back to the profile manifest when
 * it is missing, throws, or returns nothing while dependencies exist. The
 * result is sorted by id so a snapshot is deterministic.
 */
export declare function collectPlugins(options: PluginsCollectOptions): Promise<PluginsCollectResult>;
