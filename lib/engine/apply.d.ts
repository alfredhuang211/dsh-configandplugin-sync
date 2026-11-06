/**
 * The local applier: turns one planned action into a change on this device.
 *
 * Every mutation goes through a supported seam rather than editing files
 * directly:
 *
 *  - plugins are installed, enabled and removed through `ctx.pluginManager`;
 *  - entry configuration is written through `ctx.configEditor`, which preserves
 *    comments and `!!js` expressions and applies the change through the Loader;
 *  - credentials are written through `ctx.credentials`.
 *
 * The filesystem is only touched where DSH exposes no service for it: the
 * settings-page fallback when `configEditor` is missing, and a profile patch
 * entry that does not exist locally yet. Those paths are marked as requiring a
 * restart, because nothing applied them to the running composition.
 * @module engine/apply
 */
import type { ActionOutcome, ConfigFileRecord, JsonObject, JsonValue, McpServerRecord, PlanAction, ProviderRecord, SyncLogger } from '../types.js';
import type { DshConfigEditor, DshCredentials, DshLoaderEntry, DshPluginManager } from '../dsh.js';
/** Services and paths the applier needs. */
export interface ApplierOptions {
    dshHome: string;
    profile: string;
    /** Absolute profile directory. */
    profileDir: string;
    logger: SyncLogger;
    pluginManager?: DshPluginManager | undefined;
    configEditor?: DshConfigEditor | undefined;
    credentials?: DshCredentials | undefined;
    /** Passphrase for restoring the encrypted secret slice, when configured. */
    passphrase?: string | undefined;
    env?: NodeJS.ProcessEnv;
    /** Whether a change needs a DSH restart to take effect. */
    setRestartRequired?: (reason: string) => void;
}
/** Per-action execution options. */
export interface ApplyOptions {
    /** Baseline value of the item, for a safe document merge. */
    base?: JsonValue;
}
/** Applies one plan action to this device. */
export interface Applier {
    apply(action: PlanAction, options?: ApplyOptions): Promise<ActionOutcome>;
}
/** Create the local applier for one profile. */
export declare function createApplier(options: ApplierOptions): Applier;
/** Turn a provider record back into the configuration object it came from. */
export declare function providerToConfig(provider: ProviderRecord): JsonObject;
/** Turn an MCP record back into the entry configuration it came from. */
export declare function mcpToConfig(server: McpServerRecord): JsonObject;
/**
 * Scan `id` → `name` pairs out of a patch document.
 *
 * Handles both a top-level override block (`- id:` … `name:`) and the rows
 * nested in an `insert:` block, which is where a home patch usually carries a
 * `file://` plugin.
 */
export declare function scanPatchEntryNames(text: string): Array<{
    id: string;
    name: string;
}>;
/**
 * Find entries that point at a local file this device does not have.
 *
 * A `file://` plugin is machine-local by definition: its code lives at an
 * absolute path that another device does not share. Copying such an entry into
 * another device's patch would make the Loader try to import a file that is not
 * there (and would leak the path), so a restore keeps the local state instead
 * and reports what it skipped.
 */
export declare function findMachineLocalEntryIds(text: string): Promise<Array<{
    id: string;
    name: string;
}>>;
/** Merge a remote patch file into the local text without dropping local entries. */
export declare function mergePatchText(localText: string, remote: ConfigFileRecord, base: ConfigFileRecord | null): Promise<{
    text: string;
    skipped: Array<{
        id: string;
        name: string;
    }>;
}>;
/**
 * Whether a dependency specifier points at something only this machine has.
 *
 * `link:` / `file:` / `workspace:` / `portal:` all name a local path. Copying
 * one from another device's `package.json` would leave a dependency pointing at
 * a path that does not exist, and the loader would fail on the next install.
 */
export declare function isMachineLocalSpec(spec: string): boolean;
/** Merge a remote `package.json` into the local one, key by key. */
export declare function mergePackageText(localText: string | null, remote: ConfigFileRecord, base: ConfigFileRecord | null): {
    text: string;
    skipped: Array<{
        name: string;
        spec: string;
    }>;
};
/** Exported for the settings page: a one-line destination description. */
export declare function describeDestination(kind: string, destination: string): string;
/** Exported for tests: the raw YAML of one inserted entry. */
export declare function entryYaml(entry: {
    id: string;
    name: string;
    config: JsonObject;
}): string;
/** Re-exported so callers do not need to know the module layout. */
export type { DshLoaderEntry };
