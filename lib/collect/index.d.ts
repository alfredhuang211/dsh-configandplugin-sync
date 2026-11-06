/**
 * Snapshot collector: one profile in, one {@link ProfileSnapshot} out.
 *
 * The engine compares two snapshots, so this layer has exactly one job: read
 * every section the caller asked for, tolerate every Host service being absent,
 * and always return a structurally valid snapshot. A broken file or a failing
 * service becomes a warning, never an exception; only an explicit cancellation
 * aborts.
 *
 * The sections are collected in dependency order:
 *
 *  - the configuration tree provides the parsed entries and the profile
 *    manifest;
 *  - providers and MCP servers are projections of those entries;
 *  - the plugin inventory needs the manifest, the entries and the plugin
 *    manager;
 *  - plugin configuration needs the inventory to know which entries belong to
 *    which third-party plugin.
 *
 * The secret slice is deliberately *not* part of a snapshot: the engine reads
 * it through {@link readSecrets}, encrypts it and stores it as one opaque
 * document, so a plain snapshot never contains a secret value.
 * @module collect
 */
import { type CollectorServices, type DeviceInfo, type SnapshotCollector, type SyncLogger } from '../types.js';
export { collectDshConfig, parseProfilePackage } from './dsh-config.js';
export type { DshConfigReadOptions, DshConfigReadResult, ProfilePackageFacts } from './dsh-config.js';
export { JS_EXPRESSION_PREFIX, entryConfigToYamlValue, encodeJsExpressions, isJsExpressionString, readEntryRecords, readRawEntries, toConfigEntryRecord, toConfigEntryRecords, } from './entries.js';
export type { RawEntry, ReadEntriesOptions, ReadEntriesResult } from './entries.js';
export { collectMcpServers, findPackageSpec, inferInstallMethod, parsePackageSpec, redactArgs } from './mcp.js';
export type { McpCollectOptions, McpCollectResult } from './mcp.js';
export { collectPluginConfigs } from './plugin-configs.js';
export type { PluginConfigsCollectOptions } from './plugin-configs.js';
export { collectPlugins } from './plugins.js';
export type { PatchEntryRef, PluginsCollectOptions, PluginsCollectResult } from './plugins.js';
export { collectProviders, modelIds } from './providers.js';
export type { ProvidersResult } from './providers.js';
export { credentialsDocumentPath, isCredentialRecordKey, isCredentialReference, MinimalYamlError, parseCredentialsDocument, parseMinimalYaml, readSecrets, serializeCredentialsDocument, writeSecrets, } from './secrets.js';
export type { MinimalYamlValue, ParsedCredentialsDocument, SecretsReadOptions, SecretsReadResult, SecretsWriteOptions, SecretsWriteResult, StoredCredentialRecord, } from './secrets.js';
/** Options of {@link createSnapshotCollector}. */
export interface SnapshotCollectorOptions {
    /**
     * Device identity stamped into every snapshot. The engine owns the stable id
     * (it persists it); when omitted a best-effort identity is derived.
     */
    device?: DeviceInfo;
    /** Host services used when the per-call context does not supply them. */
    services?: CollectorServices;
    /** Logger used when the per-call context does not supply one. */
    logger?: SyncLogger;
    /** Clock override, for deterministic snapshots in tests. */
    now?: () => Date;
}
/**
 * Create the {@link SnapshotCollector} the engine calls once per profile.
 *
 * The returned collector reads whatever the scopes enable, shares one
 * configuration read between the sections that need it, and never throws for a
 * missing service or an unreadable file. The only two exceptions it surfaces are
 * a cancellation (`AbortError`) and an invalid profile name, which cannot
 * produce a meaningful snapshot.
 */
export declare function createSnapshotCollector(options?: SnapshotCollectorOptions): SnapshotCollector;
