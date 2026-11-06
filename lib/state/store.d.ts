/**
 * Local persisted state: this plugin's own configuration and runtime baseline.
 *
 * Both documents live under `$DSH_HOME/dsh-configandplugin-sync/` with private
 * permissions. The configuration holds storage credentials (a WebDAV password,
 * an S3 secret key) because they have to be usable offline, so it is written
 * `0600` and never synchronized; the baseline holds only what the device last
 * agreed with the store, which is what makes a three-way merge possible.
 * @module state/store
 */
import type { AutoSyncConfig, DeviceInfo, LocalState, SectionScopes, SyncConfig } from '../types.js';
/** Every path this plugin owns inside the DSH home. */
export interface StorePaths {
    /** `$DSH_HOME/dsh-configandplugin-sync` */
    dataDir: string;
    /** The plugin's private configuration. */
    configPath: string;
    /** The persisted runtime state and baseline. */
    statePath: string;
    /** The append-only log file. */
    logPath: string;
    /** Git work trees and scratch files. */
    workDir: string;
    /** Temporary downloads and rollback snapshots. */
    tempDir: string;
}
/** Resolve every path this plugin owns. */
export declare function resolveStorePaths(dshHome: string): StorePaths;
/** Create every private directory the plugin owns. */
export declare function ensureStoreDirs(paths: StorePaths): Promise<void>;
/** Default automatic-sync policy: off, and conservative when switched on. */
export declare function defaultAutoSync(): AutoSyncConfig;
/** Suggestions for the section switches, before a user edits them. */
export declare function defaultSectionScopes(): SectionScopes;
/** Built-in default configuration, valid before the user configures anything. */
export declare function defaultConfig(activeProfile: string, availableProfiles: readonly string[]): SyncConfig;
/** The host name as a human device name, trimmed to a sane length. */
export declare function defaultDeviceName(): string;
/** Stable device identity, generated once per DSH home. */
export declare function createDeviceInfo(options: {
    existing: DeviceInfo | null;
    name: string;
    dshVersion: string;
    pluginVersion: string;
}): DeviceInfo;
/** Fresh runtime state for one device. */
export declare function defaultState(device: DeviceInfo): LocalState;
/**
 * Normalize arbitrary JSON into a valid configuration.
 *
 * The settings page may send a partial or stale object (a field added by a
 * newer version, a backend block missing from an older client), so every field
 * is defaulted rather than trusted.
 */
export declare function normalizeConfig(input: unknown, activeProfile: string, availableProfiles: readonly string[]): SyncConfig;
/** Read the plugin configuration, falling back to defaults when absent or corrupt. */
export declare class ConfigStore {
    readonly path: string;
    private readonly normalize;
    constructor(path: string, normalize: (input: unknown) => SyncConfig);
    read(): Promise<SyncConfig>;
    write(config: SyncConfig): Promise<void>;
    /** Display form of the directory. */
    get displayPath(): string;
}
/** Read/write the local runtime state. */
export declare class StateStore {
    readonly path: string;
    private readonly fresh;
    constructor(path: string, fresh: () => LocalState);
    read(): Promise<LocalState>;
    write(state: LocalState): Promise<void>;
}
/** The profile directory for one profile name. */
export declare function profileDir(dshHome: string, profile: string): string;
/** The file name (not path) of a profile. */
export declare function profileNameOf(dir: string): string;
