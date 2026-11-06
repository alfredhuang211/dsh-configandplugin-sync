/**
 * The sync engine: every operation the settings page and the agent tools call.
 *
 * One engine instance owns the read/compute/write cycle and serializes mutating
 * operations through a single mutex, so a settings-page click and an agent tool
 * can never write the store at the same time.
 *
 * Notable invariants:
 *
 *  - a plan is always computed before anything changes, and a destructive plan
 *    or an unresolved conflict refuses to execute;
 *  - the store is only written for actions the plan actually contains, so a
 *    "backup" never deletes a remote item a pull would have added;
 *  - the local baseline is only advanced for items both sides now agree on,
 *    which is what keeps an unresolved difference visible on the next run.
 * @module engine/index
 */
import type { AutoSyncConfig, ConnectionTestResult, DeviceInfo, HistoryEntry, LogEntry, OperationResult, PlanAction, SectionId, StatusView, SyncBackend, SyncConfig, SyncConfigView, SyncLogger, SyncPlan } from '../types.js';
import { hashOf, asConfigFile } from './sections.js';
import { parseContents } from './repository.js';
import type { CollectorServices, SnapshotCollector } from '../types.js';
import type { ConfigStore, StateStore, StorePaths } from '../state/store.js';
/** Everything the engine needs from the plugin entry. */
export interface SyncEngineDeps {
    logger: SyncLogger;
    configStore: ConfigStore;
    stateStore: StateStore;
    paths: StorePaths;
    dshHome: string;
    profilesRoot: string;
    activeProfile: string;
    availableProfiles: readonly string[];
    pluginVersion: string;
    dshVersion: string;
    device: DeviceInfo;
    env: NodeJS.ProcessEnv;
    collector: SnapshotCollector;
    services: CollectorServices;
    /** Build the active storage backend; throws `not-configured` when it is incomplete. */
    createBackend: (config: SyncConfig) => SyncBackend;
    /** Called when the configuration changed so the scheduler can follow it. */
    onConfigChanged?: (config: SyncConfig) => void;
    now?: () => Date;
}
/** Options shared by the read-only and mutating operations. */
export interface PlanOptions {
    profile?: string | undefined;
    refresh?: boolean | undefined;
    signal?: AbortSignal | undefined;
}
/** Options of a mutating operation. */
export interface MutateOptions extends PlanOptions {
    confirmDestructive?: boolean | undefined;
    resolutions?: import('../types.js').ConflictResolution[] | undefined;
    itemIds?: string[] | undefined;
    message?: string | undefined;
}
/** The engine surface used by the HTTP routes and the agent tools. */
export interface SyncEngine {
    status(options?: PlanOptions): Promise<StatusView>;
    saveConfig(input: unknown): Promise<SyncConfigView>;
    configView(): Promise<SyncConfigView>;
    testConnection(options?: {
        config?: SyncConfig | undefined;
        signal?: AbortSignal | undefined;
    }): Promise<ConnectionTestResult>;
    inventory(profile?: string): Promise<InventoryView>;
    diff(options: MutateOptions & {
        direction?: 'push' | 'pull' | 'two-way';
    }): Promise<{
        plan: SyncPlan;
        revision: string | null;
    }>;
    backup(options: MutateOptions): Promise<OperationResult>;
    previewRestore(options: PlanOptions): Promise<{
        plan: SyncPlan;
        revision: string | null;
        source: 'head' | 'snapshot';
    }>;
    restore(options: MutateOptions): Promise<OperationResult>;
    previewSync(options?: PlanOptions): Promise<{
        plan: SyncPlan;
        revision: string | null;
    }>;
    sync(options: MutateOptions): Promise<OperationResult>;
    history(options?: {
        limit?: number | undefined;
        signal?: AbortSignal | undefined;
    }): Promise<{
        entries: HistoryEntry[];
    }>;
    listSnapshots(options?: PlanOptions): Promise<SnapshotSummary[]>;
    rollback(options: MutateOptions & {
        revision: string;
    }): Promise<OperationResult>;
    setAutoSync(patch: Partial<AutoSyncConfig>): Promise<SyncConfigView>;
    logs(options?: {
        limit?: number | undefined;
    }): Promise<{
        entries: LogEntry[];
    }>;
    secretsStatus(options?: PlanOptions): Promise<SecretsStatusView>;
    unlockSecrets(options: {
        passphrase?: string | undefined;
        signal?: AbortSignal | undefined;
    }): Promise<{
        ok: boolean;
        refCount: number;
        createdAt: string;
    }>;
    inspectPlugin(spec: string): Promise<PluginInspectView>;
    invalidate(): void;
    /** Whether an operation currently runs. */
    busy(): boolean;
    /** Loaded configuration, for the scheduler. */
    config(): Promise<SyncConfig>;
}
/** Inventory summary the Plugins tab renders. */
export interface InventoryView {
    profile: string;
    plugins: Array<{
        id: string;
        name: string;
        version: string | null;
        origin: string;
        enabled: boolean;
        restorable: boolean;
        installSpec: string | null;
        builtIn: boolean;
        syncable: boolean;
    }>;
    providers: Array<{
        id: string;
        displayName?: string;
        api?: string;
        baseURL?: string;
        models: number;
    }>;
    mcp: Array<{
        id: string;
        serverName: string;
        transport: string;
        installMethod: string;
        packageName?: string;
        packageVersion?: string;
        command?: string;
        url?: string;
        headerNames: string[];
        envNames: string[];
        enabled: boolean;
    }>;
    secrets: {
        refs: number;
        records: number;
        encrypted: boolean;
    };
    dsh: {
        files: number;
        entries: number;
        bundles: number;
    };
    /** Plugins that carry synchronized configuration. */
    pluginConfigs: number;
    /**
     * How many DeepSeek official/built-in bundles were left out of `plugins`.
     * The inventory lists post-installed plugins only; the count keeps the page
     * honest about what it is not showing.
     */
    hiddenOfficialPlugins: number;
    /** The profile's default model selection, when declared. */
    defaultModel: {
        provider?: string;
        model?: string;
    } | null;
    /** Non-fatal findings from the scan, safe to display. */
    warnings: string[];
}
/** One rollback snapshot as the history tab lists it. */
export interface SnapshotSummary {
    path: string;
    createdAt: string;
    deviceName: string;
    deviceId: string;
    operation: string;
    itemCount: number;
}
/** Secrets presence view; values never cross this boundary. */
export interface SecretsStatusView {
    stored: boolean;
    createdAt?: string;
    refCount?: number;
    passphraseAvailable: boolean;
    localRefs: string[];
    localRecords: string[];
}
/** A plugin spec inspection result. */
export interface PluginInspectView {
    accepted: boolean;
    kind?: string;
    name?: string;
    version?: string;
    reason?: string;
}
/** Create the sync engine. */
export declare function createEngine(deps: SyncEngineDeps): SyncEngine;
/**
 * Whether a plugin is provided by DeepSeek itself.
 *
 * A built-in bundle ships with DSH (or is offered by the installation), so it is
 * not a post-installed plugin: it is never listed in the inventory and never
 * synchronized.
 */
export declare function isOfficialPlugin(plugin: {
    builtIn?: boolean;
    origin?: string;
}): boolean;
/** Whether one section is enabled by the configuration scopes. */
export declare function sectionEnabled(config: SyncConfig, section: SectionId): boolean;
/** Whether an action mutates this device. */
export declare function isLocalAction(kind: PlanAction['kind']): boolean;
/** Whether an action mutates the store. */
export declare function isPushAction(kind: PlanAction['kind']): boolean;
/** Re-exported so the plugin entry can describe what it loaded. */
export declare const ENGINE_TITLES: {
    readonly zh: "DSH 配置与插件同步";
    readonly en: "DSH Config & Plugin Sync";
};
/** Exported for tests. */
export { parseContents, hashOf, asConfigFile };
