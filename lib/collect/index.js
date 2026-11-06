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
import { hostname } from 'node:os';
import { SyncError } from '../core/errors.js';
import { SCHEMA_VERSION, } from '../types.js';
import { collectDshConfig } from './dsh-config.js';
import { collectMcpServers } from './mcp.js';
import { collectPluginConfigs } from './plugin-configs.js';
import { collectPlugins } from './plugins.js';
import { collectProviders } from './providers.js';
export { collectDshConfig, parseProfilePackage } from './dsh-config.js';
export { JS_EXPRESSION_PREFIX, entryConfigToYamlValue, encodeJsExpressions, isJsExpressionString, readEntryRecords, readRawEntries, toConfigEntryRecord, toConfigEntryRecords, } from './entries.js';
export { collectMcpServers, findPackageSpec, inferInstallMethod, parsePackageSpec, redactArgs } from './mcp.js';
export { collectPluginConfigs } from './plugin-configs.js';
export { collectPlugins } from './plugins.js';
export { collectProviders, modelIds } from './providers.js';
export { credentialsDocumentPath, isCredentialRecordKey, isCredentialReference, MinimalYamlError, parseCredentialsDocument, parseMinimalYaml, readSecrets, serializeCredentialsDocument, writeSecrets, } from './secrets.js';
/** Derive a best-effort device identity when the caller cannot supply one. */
function fallbackDevice(context) {
    return {
        id: 'unknown-device',
        name: safeHostname(),
        platform: process.platform,
        arch: process.arch,
        dshVersion: safeText(context.dshVersion) ?? 'unknown',
        pluginVersion: safeText(context.pluginVersion) ?? 'unknown',
    };
}
/** Host name, or a stable placeholder when it cannot be read. */
function safeHostname() {
    try {
        return hostname() || 'DSH Device';
    }
    catch {
        return 'DSH Device';
    }
}
/** Trim a value to a non-empty string, or undefined. */
function safeText(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/** Merge per-call services over the factory-level defaults. */
function mergeServices(context, fallback) {
    const out = { ...(fallback ?? {}) };
    if (context !== undefined) {
        for (const key of Object.keys(context)) {
            const value = context[key];
            if (value !== undefined)
                out[key] = value;
        }
    }
    return out;
}
/** An empty configuration record for a snapshot whose section is switched off. */
function emptyDshRecord(profile) {
    return { profile, files: [], entries: [], bundles: [], dependencies: {}, warnings: [] };
}
/** Log a warning through whichever logger is available, tolerating a throw. */
function warn(logger, message) {
    try {
        logger?.warn(message);
    }
    catch {
        // Logging must never break collection.
    }
}
/** Throw a cancellation error when the caller aborted. */
function throwIfAborted(signal) {
    if (signal?.aborted === true) {
        throw new SyncError('cancelled', '快照采集已取消 / snapshot collection was cancelled');
    }
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
export function createSnapshotCollector(options = {}) {
    const now = options.now ?? (() => new Date());
    const collect = async (context, scopes) => {
        throwIfAborted(context.signal);
        const logger = context.logger ?? options.logger;
        const services = mergeServices(context.services, options.services);
        const warnings = [];
        const recordWarning = (message) => {
            if (warnings.includes(message))
                return;
            warnings.push(message);
            warn(logger, message);
        };
        const profile = context.profile;
        const facts = await collectDshConfig({
            dshHome: context.dshHome,
            profilesRoot: context.profilesRoot,
            profile,
            configEditor: services.configEditor,
            logger,
            signal: context.signal,
        });
        for (const message of facts.record.warnings)
            recordWarning(message);
        const entries = facts.record.entries;
        throwIfAborted(context.signal);
        const providerWarnings = [];
        const providersResult = collectProviders(entries, providerWarnings);
        throwIfAborted(context.signal);
        const pluginsResult = await collectPlugins({
            profile,
            profileDir: facts.profileDir,
            dependencies: facts.dependencies,
            entries,
            pluginManager: services.pluginManager,
            platform: options.device?.platform ?? process.platform,
            logger,
            signal: context.signal,
        });
        for (const message of pluginsResult.warnings)
            recordWarning(message);
        throwIfAborted(context.signal);
        const configWarnings = [];
        const mcpWarnings = [];
        const pluginConfigs = collectPluginConfigs(pluginsResult.plugins, entries, { warnings: configWarnings });
        const mcp = collectMcpServers(entries, { warnings: mcpWarnings });
        for (const message of [...providerWarnings, ...configWarnings, ...mcpWarnings])
            recordWarning(message);
        const snapshot = {
            schemaVersion: SCHEMA_VERSION,
            profile,
            device: options.device ?? fallbackDevice(context),
            generatedAt: now().toISOString(),
            dsh: scopes.dshConfig
                ? {
                    profile: facts.record.profile,
                    files: facts.record.files,
                    entries,
                    bundles: facts.bundles,
                    dependencies: facts.dependencies,
                    warnings: [...facts.record.warnings],
                }
                : emptyDshRecord(profile),
            providers: scopes.providers ? providersResult.providers : [],
            defaultModel: scopes.providers ? providersResult.defaultModel : null,
            plugins: scopes.plugins ? pluginsResult.plugins : [],
            pluginConfigs: scopes.pluginConfigs ? pluginConfigs : [],
            mcp: scopes.mcp ? mcp.servers : [],
        };
        try {
            logger?.info('collected the profile snapshot', {
                profile,
                files: snapshot.dsh.files.length,
                entries: snapshot.dsh.entries.length,
                providers: snapshot.providers.length,
                plugins: snapshot.plugins.length,
                pluginConfigs: snapshot.pluginConfigs.length,
                mcp: snapshot.mcp.length,
            });
        }
        catch {
            // Logging must never break collection.
        }
        return snapshot;
    };
    return { collect };
}
