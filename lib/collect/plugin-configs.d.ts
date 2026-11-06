/**
 * Per-plugin configuration collection.
 *
 * For every third-party plugin this module gathers the configuration its Loader
 * entries carry, merges those entries into one value tree per plugin, and
 * projects the result through the secret rules. Official/built-in bundles are
 * skipped on purpose: their configuration is DSH's own surface, versioned with
 * DSH, and restoring it across versions is more likely to break than to help.
 *
 * The input entries are already secret-free ({@link ConfigEntryRecord}), and
 * this module applies `splitSecrets` once more as defence in depth before a
 * value reaches a record.
 * @module collect/plugin-configs
 */
import type { ConfigEntryRecord, PluginConfigRecord, PluginRecord } from '../types.js';
/** Options of {@link collectPluginConfigs}. */
export interface PluginConfigsCollectOptions {
    /** Warnings sink; the caller owns logging. */
    warnings?: string[];
}
/**
 * Collect configuration records for the third-party plugins of one profile.
 *
 * A plugin with no matching entries produces no record: there is nothing to
 * restore, and an empty record would read as "reset this plugin's config" to
 * the engine's merge.
 */
export declare function collectPluginConfigs(plugins: readonly PluginRecord[], entries: readonly ConfigEntryRecord[], options?: PluginConfigsCollectOptions): PluginConfigRecord[];
