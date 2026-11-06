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
import { join } from 'node:path';
import { SECTION_IDS } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';
import { PACKAGE_NAME, TITLE_EN, TITLE_ZH } from '../constants.js';
import { SyncError, errorMessage } from '../core/errors.js';
import { sha256Json } from '../core/hash.js';
import { sanitizeJson } from '../core/json.js';
import { createMutex } from '../core/mutex.js';
import { displayPath } from '../core/paths.js';
import { createApplier } from './apply.js';
import { decryptSecrets, encryptSecrets } from './crypto.js';
import { buildPlan, hashOf, localItemsFor, remoteItemsFor, asConfigFile, toJson, } from './sections.js';
import { createRepository, parseContents, } from './repository.js';
import { createSnapshot, encodeSnapshot, parseSnapshot, pruneSnapshotPaths, snapshotPath, } from './snapshots.js';
import { readSecrets } from '../collect/secrets.js';
/** How fresh a cached read is considered, in milliseconds. */
const CACHE_TTL_MS = 5_000;
/** Create the sync engine. */
export function createEngine(deps) {
    const logger = deps.logger;
    const now = deps.now ?? (() => new Date());
    const mutex = createMutex();
    let snapshotCache = null;
    let storeCache = null;
    let runningOperation = null;
    const collect = async (config, force = false) => {
        if (!force && snapshotCache !== null && now().getTime() - snapshotCache.at < CACHE_TTL_MS) {
            return snapshotCache.snapshot;
        }
        const snapshot = await deps.collector.collect({
            dshHome: deps.dshHome,
            profilesRoot: deps.profilesRoot,
            profile: deps.activeProfile,
            services: deps.services,
            logger,
            pluginVersion: deps.pluginVersion,
            dshVersion: deps.dshVersion,
        }, config.scopes);
        snapshotCache = { snapshot, at: now().getTime() };
        return snapshot;
    };
    const readStore = async (config, force = false) => {
        const repository = createRepository({
            backend: deps.createBackend(config),
            logger,
            generator: { name: PACKAGE_NAME, version: deps.pluginVersion },
            now,
        });
        if (!force && storeCache !== null && now().getTime() - storeCache.at < CACHE_TTL_MS) {
            return { contents: storeCache.contents, repository };
        }
        const contents = await repository.read();
        storeCache = { contents, at: now().getTime() };
        return { contents, repository };
    };
    const assertProfile = (requested) => {
        const profile = (requested ?? deps.activeProfile).trim();
        if (profile === '')
            return deps.activeProfile;
        if (profile !== deps.activeProfile) {
            throw new SyncError('unsupported', `只能同步当前运行中的 profile（${deps.activeProfile}）/ only the active profile can be synchronized`);
        }
        return profile;
    };
    const resolvePassphrase = (config, explicit) => {
        if (typeof explicit === 'string' && explicit !== '')
            return explicit;
        const name = config.passphraseEnvVar.trim();
        if (name === '')
            return '';
        return (deps.env[name] ?? '').trim();
    };
    /**
     * Read the local secret payload, if the credentials store is readable.
     *
     * `candidateRefs` seeds discovery for environment-only references: the
     * credential seam has no enumeration, so the provider `apiKeyEnv` names of
     * the current snapshot are what tell us those references exist.
     */
    const readLocalSecrets = async (config, candidateRefs = []) => {
        try {
            const result = await readSecrets({
                dshHome: deps.dshHome,
                credentialsPath: join(deps.dshHome, '.credentials.yaml'),
                credentials: deps.services.credentials,
                candidateRefs,
                logger,
                env: deps.env,
            });
            for (const warning of result.warnings)
                logger.warn(`密钥读取提示 / secret read note: ${warning}`);
            return result.payload;
        }
        catch (error) {
            logger.warn(`读取本地密钥失败 / cannot read local secrets: ${errorMessage(error)}`);
            return null;
        }
    };
    /** Build the envelope to compare/push, or null when secrets may not sync. */
    const prepareSecrets = async (config, remote, snapshot, direction) => {
        if (!config.scopes.secrets)
            return { envelope: null, warning: null };
        const passphrase = resolvePassphrase(config);
        if (passphrase === '') {
            return {
                envelope: null,
                warning: `密钥同步已启用，但环境变量 ${config.passphraseEnvVar || '(未设置)'} 中没有口令 / secrets sync is on but no passphrase is available`,
            };
        }
        const payload = await readLocalSecrets(config, snapshot.providers.map(provider => provider.apiKeyEnv ?? '').filter(name => name !== ''));
        if (payload === null)
            return { envelope: null, warning: '本机密钥无法读取 / local secrets are unreadable' };
        const hasLocal = payload.refs.length > 0 || payload.records.length > 0;
        const remoteEntry = remote.get('secrets')?.items['secrets'];
        const remotePresent = remoteEntry !== undefined && remoteEntry.deleted !== true;
        // A pull never writes the store: the remote envelope is the input.
        if (direction === 'pull')
            return { envelope: null, warning: null };
        if (remotePresent) {
            try {
                const remotePayload = await decryptSecrets(remoteEntry.value, { passphrase });
                if (sha256Json(toJson(remotePayload)) === sha256Json(toJson(payload))) {
                    // Identical content: hand back the remote envelope so the hash matches
                    // and no needless re-encryption shows up as a change.
                    return { envelope: remoteEntry.value, warning: null };
                }
            }
            catch (error) {
                // A device with the wrong passphrase must not overwrite the store: it
                // cannot know whether its local payload is newer or emptier.
                return {
                    envelope: null,
                    warning: `无法用当前口令解开远程密钥包，本次不推送密钥 / cannot decrypt the remote secret envelope with this passphrase; secrets are not pushed: ${errorMessage(error)}`,
                };
            }
            if (direction === 'two-way') {
                // Both sides differ and the documents cannot be merged: pull this run,
                // push only on an explicit backup.
                return { envelope: null, warning: null };
            }
            if (!hasLocal)
                return { envelope: null, warning: null };
        }
        else if (!hasLocal) {
            return { envelope: null, warning: null };
        }
        const envelope = await encryptSecrets(payload, { passphrase, deviceId: deps.device.id, now });
        return { envelope, warning: null };
    };
    const prepare = async (options, direction = 'two-way') => {
        const config = await deps.configStore.read();
        const state = await deps.stateStore.read();
        const profile = assertProfile(options.profile);
        const { contents, repository } = await readStore(config, options.refresh === true);
        const remote = contents.profiles.get(profile) ?? new Map();
        const baseline = state.baselines[profile]?.sections ?? {};
        const snapshot = await collect(config, options.refresh === true);
        const secrets = await prepareSecrets(config, remote, snapshot, direction);
        return {
            config,
            state,
            repository,
            contents,
            profile,
            remote,
            baseline,
            snapshot,
            secretsEnvelope: secrets.envelope,
            secretsWarning: secrets.warning,
        };
    };
    const planFor = (prepared, direction, resolutions) => {
        const plan = buildPlan({
            direction,
            profile: prepared.profile,
            snapshot: prepared.snapshot,
            remote: prepared.remote,
            baseline: prepared.baseline,
            enabled: {
                'dsh-config': prepared.config.scopes.dshConfig,
                providers: prepared.config.scopes.providers,
                plugins: prepared.config.scopes.plugins,
                'plugin-configs': prepared.config.scopes.pluginConfigs,
                secrets: prepared.config.scopes.secrets,
                mcp: prepared.config.scopes.mcp,
            },
            excluded: prepared.config.excluded,
            resolutions: resolutions ?? [],
            secretsEnvelope: prepared.secretsEnvelope,
            now,
        });
        if (prepared.secretsWarning !== null)
            plan.warnings.push(prepared.secretsWarning);
        // Collector findings (a masked credential in a patch file, an unreadable
        // config file, a plugin that could not be inspected) belong to the plan the
        // user reviews, not only to the log.
        for (const warning of prepared.snapshot.dsh.warnings) {
            if (!plan.warnings.includes(warning))
                plan.warnings.push(warning);
        }
        return plan;
    };
    const applierFor = (config, passphrase) => createApplier({
        dshHome: deps.dshHome,
        profile: deps.activeProfile,
        profileDir: join(deps.dshHome, 'profiles', deps.activeProfile),
        logger,
        pluginManager: deps.services.pluginManager,
        configEditor: deps.services.configEditor,
        credentials: deps.services.credentials,
        passphrase,
        env: deps.env,
        setRestartRequired: reason => {
            restartReasons.add(reason);
        },
    });
    // Restart reasons are per operation; the set is cleared when one starts.
    const restartReasons = new Set();
    /** Execute a plan: pull locally, then push what the plan listed. */
    const execute = async (prepared, plan, options) => {
        const startedAt = now().toISOString();
        restartReasons.clear();
        const destructive = plan.actions.filter(action => action.destructive);
        if (destructive.length > 0 && options.confirmDestructive !== true) {
            throw new SyncError('confirmation-required', '计划包含删除操作，需要显式确认 / the plan contains destructive actions; confirm explicitly', { plan });
        }
        if (plan.conflicts.length > 0) {
            throw new SyncError('conflict-present', '存在需要用户决定的冲突 / unresolved conflicts need a decision', { plan });
        }
        const passphrase = resolvePassphrase(prepared.config);
        const applier = applierFor(prepared.config, passphrase);
        const outcomes = [];
        const selected = new Set(options.itemIds ?? []);
        const shouldRun = (action) => selected.size === 0 || selected.has(action.id) || selected.has(`${action.section}:${action.id}`);
        // 1. Local side of the plan.
        for (const action of plan.actions) {
            if (!isLocalAction(action.kind))
                continue;
            if (!shouldRun(action)) {
                outcomes.push({ action, ok: true, skipped: true, detail: '未选择 / not selected' });
                continue;
            }
            const base = prepared.baseline[action.section]?.[action.id]?.value;
            const outcome = await applier.apply(action, base === undefined ? {} : { base });
            outcomes.push(outcome);
        }
        // 2. Store side of the plan.
        const pushActions = plan.actions.filter(action => isPushAction(action.kind) && shouldRun(action));
        const removals = plan.actions.filter(action => action.kind === 'remove-remote-item' && shouldRun(action));
        let revision = prepared.contents.revision;
        let pushed = false;
        let writeResult = { changed: false, revision };
        if ((pushActions.length > 0 || removals.length > 0) && plan.direction !== 'pull') {
            const sections = buildPushSections({
                prepared,
                actions: [...pushActions, ...removals],
                timestamp: now().toISOString(),
                device: deps.device,
            });
            const snapshotDocument = createSnapshot({
                profile: prepared.profile,
                deviceId: deps.device.id,
                deviceName: deps.device.name,
                operation: plan.direction === 'push' ? 'backup' : 'sync',
                sections: snapshotSections(sections),
                createdAt: now().toISOString(),
            });
            const snapshotRelative = snapshotPath(prepared.profile, deps.device.id, snapshotDocument.createdAt);
            const extraFiles = new Map([[snapshotRelative, encodeSnapshot(snapshotDocument)]]);
            const extraDeletions = pruneSnapshotPaths([...prepared.contents.files.keys(), snapshotRelative], prepared.profile, deps.device.id);
            const deviceDocument = buildDeviceDocument(deps.device, prepared.snapshot, prepared.profile, now().toISOString());
            const change = {
                profile: prepared.profile,
                sections,
                device: deviceDocument,
                extraFiles,
                extraDeletions,
                message: options.message ?? defaultMessage(plan),
                trailers: {
                    operation: plan.direction === 'push' ? 'backup' : 'sync',
                    deviceId: deps.device.id,
                    deviceName: deps.device.name,
                    profile: prepared.profile,
                    result: 'ok',
                    itemCount: String(pushActions.length + removals.length),
                },
                signal: options.signal,
                rebuild: async (fresh) => {
                    // Another device wrote first: keep its untouched sections and only
                    // re-apply the actions this run planned.
                    const merged = {};
                    for (const section of Object.keys(sections)) {
                        const freshSection = fresh.profiles.get(prepared.profile)?.get(section);
                        const next = rebuildSection(sections[section], freshSection);
                        if (next !== null)
                            merged[section] = next;
                    }
                    return {
                        ...change,
                        sections: merged,
                    };
                },
            };
            writeResult = await prepared.repository.write(change);
            revision = writeResult.revision;
            pushed = writeResult.changed;
            for (const action of [...pushActions, ...removals]) {
                outcomes.push({
                    action,
                    ok: true,
                    detail: writeResult.changed ? '已写入存储 / written to the store' : '存储已是最新 / store already up to date',
                });
            }
            storeCache = null;
        }
        else {
            for (const action of [...pushActions, ...removals]) {
                outcomes.push({ action, ok: true, skipped: true, detail: '无存储变更 / no store change' });
            }
        }
        // 3. Baseline: only what both sides now agree on.
        const refreshedSnapshot = await collect(prepared.config, true);
        const freshRemote = pushed ? await readFreshSections(prepared, revision) : prepared.remote;
        const nextBaseline = buildBaseline(prepared.profile, refreshedSnapshot, freshRemote, revision, now().toISOString());
        const state = await deps.stateStore.read();
        state.baselines[prepared.profile] = nextBaseline;
        const failed = outcomes.filter(outcome => !outcome.ok);
        state.lastSyncAt = now().toISOString();
        state.lastRevision = revision;
        state.lastError = failed.length > 0 ? failed[0]?.error ?? 'unknown error' : null;
        state.autoSyncFailures = failed.length > 0 ? state.autoSyncFailures + 1 : 0;
        state.lastOperation = {
            operation: plan.direction === 'push' ? 'backup' : plan.direction === 'pull' ? 'restore' : 'sync',
            at: state.lastSyncAt,
            ok: failed.length === 0,
            ...(failed.length === 0 ? {} : { error: failed[0]?.error ?? 'unknown error' }),
            revision,
            changedItems: outcomes.filter(outcome => outcome.ok && outcome.skipped !== true).length,
        };
        await deps.stateStore.write(state);
        return {
            ok: failed.length === 0,
            operation: plan.direction === 'push' ? 'backup' : plan.direction === 'pull' ? 'restore' : 'sync',
            startedAt,
            finishedAt: now().toISOString(),
            revision,
            pushed,
            noChanges: outcomes.every(outcome => outcome.skipped === true) && !pushed,
            actionOutcomes: outcomes,
            warnings: [...plan.warnings, ...restartReasonsToWarnings()],
            ...(failed.length === 0 ? {} : { error: failed[0]?.error ?? 'unknown error' }),
            ...(restartReasons.size === 0 ? {} : { restartRequired: true }),
        };
    };
    const restartReasonsToWarnings = () => [...restartReasons].map(reason => `需要重启 DSH 生效 / restart DSH to apply: ${reason}`);
    /** Read the sections that now exist in the store after a write. */
    const readFreshSections = async (prepared, revision) => {
        try {
            const contents = await prepared.repository.read();
            storeCache = { contents, at: now().getTime() };
            return contents.profiles.get(prepared.profile) ?? new Map();
        }
        catch (error) {
            logger.warn(`写入后无法重新读取存储 / cannot re-read the store after writing: ${errorMessage(error)}`);
            void revision;
            return prepared.remote;
        }
    };
    const runOperation = async (name, task) => {
        const release = mutex.tryAcquire(name);
        if (release === null) {
            throw new SyncError('busy', `正在执行 ${mutex.holder() ?? '其他操作'} / another operation is running`);
        }
        runningOperation = name;
        try {
            return await task();
        }
        finally {
            runningOperation = null;
            release();
        }
    };
    const buildConfigView = (config, state) => {
        const passphrase = resolvePassphrase(config);
        const token = config.git.tokenEnvVar === '' ? '' : (deps.env[config.git.tokenEnvVar] ?? '');
        return {
            ...config,
            passphraseAvailable: passphrase !== '',
            tokenAvailable: token.trim() !== '',
            device: state.device,
            activeProfile: deps.activeProfile,
            availableProfiles: [...deps.availableProfiles],
            dataDir: displayPath(deps.paths.dataDir),
        };
    };
    const configured = (config) => {
        if (config.backendKind === 'git') {
            if (config.git.repoUrl.trim() === '')
                return { ok: false, reason: 'Git 仓库地址为空 / the git repository URL is empty' };
            return { ok: true, reason: '' };
        }
        if (config.backendKind === 'webdav') {
            if (config.webdav.url.trim() === '')
                return { ok: false, reason: 'WebDAV 地址为空 / the WebDAV URL is empty' };
            return { ok: true, reason: '' };
        }
        if (config.s3.bucket.trim() === '')
            return { ok: false, reason: 'S3 bucket 为空 / the S3 bucket is empty' };
        if (config.s3.endpoint.trim() === '')
            return { ok: false, reason: 'S3 端点为空 / the S3 endpoint is empty' };
        return { ok: true, reason: '' };
    };
    const status = async (options = {}) => {
        const config = await deps.configStore.read();
        const state = await deps.stateStore.read();
        const configView = buildConfigView(config, state);
        const readiness = configured(config);
        const base = {
            state: readiness.ok ? 'unknown' : 'not-configured',
            config: configView,
            branch: config.backendKind === 'git' ? config.git.branch : '',
            lastSyncAt: state.lastSyncAt,
            lastRevision: state.lastRevision,
            lastOperation: state.lastOperation,
            localItemCount: 0,
            remoteItemCount: null,
            pendingUploads: 0,
            pendingDownloads: 0,
            conflictCount: 0,
            lastError: readiness.ok ? state.lastError : readiness.reason,
            warnings: [],
            autoSyncFailures: state.autoSyncFailures,
            busy: runningOperation !== null,
            connection: state.connection,
            sections: [],
        };
        if (!readiness.ok)
            return base;
        try {
            const prepared = await prepare({ ...options, refresh: options.refresh === true }, 'two-way');
            const plan = planFor(prepared, 'two-way', []);
            const sections = SECTION_IDS.map(section => buildSectionStatus(section, prepared, plan));
            const pendingUploads = plan.actions.filter(action => isPushAction(action.kind)).length;
            const pendingDownloads = plan.actions.filter(action => isLocalAction(action.kind)).length;
            const syncState = plan.conflicts.length > 0
                ? 'conflict'
                : pendingUploads > 0 && pendingDownloads > 0
                    ? 'diverged'
                    : pendingUploads > 0
                        ? 'ahead'
                        : pendingDownloads > 0
                            ? 'behind'
                            : 'synced';
            return {
                ...base,
                state: syncState,
                localItemCount: plan.localItemCount,
                remoteItemCount: plan.remoteItemCount,
                pendingUploads,
                pendingDownloads,
                conflictCount: plan.conflicts.length,
                // A warning is not an error: masking a credential or skipping an
                // unreadable file is reported in its own list, so a healthy state stays
                // "synced" with lastError null.
                lastError: state.lastError,
                warnings: [...plan.warnings],
                sections,
            };
        }
        catch (error) {
            const syncError = error instanceof SyncError ? error : new SyncError('internal', errorMessage(error));
            return {
                ...base,
                state: syncError.code === 'not-configured' ? 'not-configured' : 'error',
                lastError: syncError.message,
                warnings: [],
                sections: SECTION_IDS.map(section => ({
                    section,
                    enabled: sectionEnabled(config, section),
                    localCount: 0,
                    remoteCount: null,
                    changedCount: 0,
                    conflictCount: 0,
                    lastUpdatedAt: null,
                    ...(section === 'secrets' && config.scopes.secrets && !configView.passphraseAvailable
                        ? { blocked: '需要口令 / passphrase required' }
                        : {}),
                })),
            };
        }
    };
    const buildSectionStatus = (section, prepared, plan) => {
        const enabled = sectionEnabled(prepared.config, section);
        const localItems = section === 'secrets' ? new Map() : localItemsFor(prepared.snapshot, section);
        const remoteItems = remoteItemsFor(prepared.remote.get(section), section);
        const diffs = plan.diffs.filter(diff => diff.section === section);
        const conflicts = plan.conflicts.filter(conflict => conflict.section === section);
        const remoteDocument = prepared.remote.get(section);
        return {
            section,
            enabled,
            localCount: localItems.size,
            remoteCount: [...remoteItems.values()].filter(item => !item.deleted).length,
            changedCount: diffs.length,
            conflictCount: conflicts.length,
            lastUpdatedAt: remoteDocument?.updatedAt ?? null,
            ...(!enabled
                ? { blocked: '已在范围外关闭 / disabled by scope' }
                : section === 'secrets' && prepared.secretsWarning !== null
                    ? { blocked: prepared.secretsWarning }
                    : {}),
        };
    };
    const saveConfig = async (input) => {
        const current = await deps.configStore.read();
        const merged = mergeRawConfig(current, input);
        const next = await deps.configStore.write(merged);
        const config = next === undefined ? await deps.configStore.read() : next;
        const state = await deps.stateStore.read();
        state.device = { ...state.device, name: config.deviceName };
        await deps.stateStore.write(state);
        storeCache = null;
        deps.onConfigChanged?.(config);
        logger.info('同步配置已保存 / configuration saved', {
            backend: config.backendKind,
            scopes: sanitizeJson(config.scopes),
        });
        return buildConfigView(config, state);
    };
    const configView = async () => {
        const config = await deps.configStore.read();
        const state = await deps.stateStore.read();
        return buildConfigView(config, state);
    };
    const testConnection = async (options = {}) => {
        const config = options.config ?? (await deps.configStore.read());
        const readiness = configured(config);
        const at = now().toISOString();
        if (!readiness.ok) {
            const result = { ok: false, at, kind: config.backendKind, revision: null, message: readiness.reason };
            await recordConnection(result);
            return result;
        }
        try {
            const backend = deps.createBackend(config);
            const result = await backend.testConnection(options.signal);
            await recordConnection(result);
            return result;
        }
        catch (error) {
            const syncError = error instanceof SyncError ? error : new SyncError('internal', errorMessage(error));
            const result = {
                ok: false,
                at,
                kind: config.backendKind,
                revision: null,
                message: syncError.message,
            };
            await recordConnection(result);
            return result;
        }
    };
    const recordConnection = async (result) => {
        const state = await deps.stateStore.read();
        state.connection = result;
        await deps.stateStore.write(state);
    };
    const inventory = async (profile) => {
        const config = await deps.configStore.read();
        const active = assertProfile(profile);
        const snapshot = await collect(config, true);
        const secrets = await readLocalSecrets(config, snapshot.providers.map(provider => provider.apiKeyEnv ?? '').filter(name => name !== ''));
        return {
            profile: active,
            plugins: snapshot.plugins.map(plugin => ({
                id: plugin.id,
                name: plugin.name,
                version: plugin.version,
                origin: plugin.origin,
                enabled: plugin.enabled,
                restorable: plugin.restorable,
                installSpec: plugin.installSpec,
                builtIn: plugin.builtIn,
                syncable: plugin.syncable,
            })),
            providers: snapshot.providers.map(provider => ({
                id: provider.id,
                displayName: provider.displayName,
                api: provider.api,
                baseURL: provider.baseURL,
                models: provider.models.length,
            })),
            mcp: snapshot.mcp.map(server => ({
                id: server.id,
                serverName: server.serverName,
                transport: server.transport,
                installMethod: server.installMethod,
                packageName: server.packageName,
                packageVersion: server.packageVersion,
                command: server.command,
                url: server.url,
                headerNames: [...server.headerNames],
                envNames: [...server.envNames],
                enabled: server.enabled,
            })),
            secrets: {
                refs: secrets?.refs.length ?? 0,
                records: secrets?.records.length ?? 0,
                encrypted: config.scopes.secrets,
            },
            dsh: {
                files: snapshot.dsh.files.length,
                entries: snapshot.dsh.entries.length,
                bundles: snapshot.dsh.bundles.length,
            },
            pluginConfigs: snapshot.pluginConfigs.length,
            defaultModel: snapshot.defaultModel === null
                ? null
                : {
                    ...(snapshot.defaultModel.provider === undefined ? {} : { provider: snapshot.defaultModel.provider }),
                    ...(snapshot.defaultModel.model === undefined ? {} : { model: snapshot.defaultModel.model }),
                },
            warnings: [...snapshot.dsh.warnings],
        };
    };
    const diff = async (options) => {
        const direction = options.direction ?? 'two-way';
        const prepared = await prepare(options, direction);
        const plan = planFor(prepared, direction, options.resolutions);
        return { plan, revision: prepared.contents.revision };
    };
    const previewSync = async (options = {}) => diff({ ...options, direction: 'two-way' });
    const backup = async (options) => runOperation('backup', async () => {
        const prepared = await prepare(options, 'push');
        const plan = planFor(prepared, 'push', options.resolutions);
        return execute(prepared, plan, options);
    });
    const previewRestore = async (options = {}) => {
        const prepared = await prepare(options, 'pull');
        const plan = planFor(prepared, 'pull', []);
        return { plan, revision: prepared.contents.revision, source: 'head' };
    };
    const restore = async (options) => runOperation('restore', async () => {
        const prepared = await prepare(options, 'pull');
        const plan = planFor(prepared, 'pull', options.resolutions);
        return execute(prepared, plan, options);
    });
    const sync = async (options) => runOperation('sync', async () => {
        const prepared = await prepare(options, 'two-way');
        const plan = planFor(prepared, 'two-way', options.resolutions);
        return execute(prepared, plan, options);
    });
    const history = async (options = {}) => {
        const config = await deps.configStore.read();
        if (!configured(config).ok)
            return { entries: [] };
        try {
            const backend = deps.createBackend(config);
            const entries = await backend.history({ limit: options.limit ?? 20, signal: options.signal });
            return { entries };
        }
        catch (error) {
            logger.warn(`读取历史失败 / cannot read history: ${errorMessage(error)}`);
            return { entries: [] };
        }
    };
    const listSnapshots = async (options = {}) => {
        const prepared = await prepare(options, 'pull');
        const prefix = `snapshots/${prepared.profile}/`;
        const out = [];
        for (const [path, bytes] of prepared.contents.files) {
            if (!path.startsWith(prefix) || !path.endsWith('.json'))
                continue;
            const document = parseSnapshot(bytes);
            if (document === null)
                continue;
            out.push({
                path,
                createdAt: document.createdAt,
                deviceName: document.deviceName,
                deviceId: document.deviceId,
                operation: document.operation,
                itemCount: countSnapshotItems(document),
            });
        }
        return out.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    };
    const rollback = async (options) => runOperation('rollback', async () => {
        const startedAt = now().toISOString();
        const config = await deps.configStore.read();
        const state = await deps.stateStore.read();
        const profile = assertProfile(options.profile);
        const { contents } = await readStore(config, true);
        const bytes = contents.files.get(options.revision);
        if (bytes === undefined) {
            throw new SyncError('not-found', `未找到快照 ${options.revision} / no such snapshot; history rollback needs a snapshot path`);
        }
        const document = parseSnapshot(bytes);
        if (document === null)
            throw new SyncError('invalid-config', '快照文件无法解析 / the snapshot cannot be parsed');
        if (document.profile !== profile) {
            throw new SyncError('invalid-config', `快照属于 profile ${document.profile} / the snapshot belongs to another profile`);
        }
        // Build a synthetic remote view from the snapshot and pull it.
        const remote = new Map();
        for (const [section, items] of Object.entries(document.sections)) {
            if (items === undefined)
                continue;
            remote.set(section, {
                schemaVersion: SCHEMA_VERSION,
                profile,
                section,
                revision: 0,
                updatedAt: document.createdAt,
                items: Object.fromEntries(Object.entries(items).map(([id, item]) => [
                    id,
                    {
                        value: item.value,
                        ...(item.deleted === true ? { deleted: true } : {}),
                        updatedAt: item.updatedAt,
                        updatedBy: item.updatedBy,
                    },
                ])),
            });
        }
        const snapshot = await collect(config, true);
        const plan = buildPlan({
            direction: 'pull',
            profile,
            snapshot,
            remote,
            baseline: state.baselines[profile]?.sections ?? {},
            enabled: {
                'dsh-config': config.scopes.dshConfig,
                providers: config.scopes.providers,
                plugins: config.scopes.plugins,
                'plugin-configs': config.scopes.pluginConfigs,
                secrets: config.scopes.secrets,
                mcp: config.scopes.mcp,
            },
            excluded: config.excluded,
            resolutions: options.resolutions ?? [],
            secretsEnvelope: null,
            now,
        });
        const prepared = {
            config,
            state,
            repository: createRepository({
                backend: deps.createBackend(config),
                logger,
                generator: { name: PACKAGE_NAME, version: deps.pluginVersion },
                now,
            }),
            contents,
            profile,
            remote,
            baseline: state.baselines[profile]?.sections ?? {},
            snapshot,
            secretsEnvelope: null,
            secretsWarning: null,
        };
        const result = await execute(prepared, plan, { ...options, confirmDestructive: options.confirmDestructive });
        return { ...result, operation: 'rollback', startedAt };
    });
    const setAutoSync = async (patch) => {
        const config = await deps.configStore.read();
        const next = { ...config, autoSync: { ...config.autoSync, ...patch } };
        const written = await deps.configStore.write(next);
        const saved = written === undefined ? await deps.configStore.read() : next;
        deps.onConfigChanged?.(saved);
        const state = await deps.stateStore.read();
        return buildConfigView(saved, state);
    };
    const logs = async (options = {}) => ({
        entries: logger.recent(Math.min(500, Math.max(1, options.limit ?? 100))),
    });
    const secretsStatus = async (options = {}) => {
        const config = await deps.configStore.read();
        const payload = await readLocalSecrets(config);
        const view = {
            stored: false,
            passphraseAvailable: resolvePassphrase(config) !== '',
            localRefs: payload?.refs.map(ref => ref.ref).sort() ?? [],
            localRecords: payload?.records.map(record => record.key).sort() ?? [],
        };
        if (!configured(config).ok)
            return view;
        try {
            const prepared = await prepare(options);
            const entry = prepared.remote.get('secrets')?.items['secrets'];
            if (entry !== undefined && entry.deleted !== true) {
                view.stored = true;
                view.createdAt = entry.value.createdAt;
                view.refCount = entry.value.refCount;
            }
        }
        catch (error) {
            logger.warn(`读取远程密钥状态失败 / cannot read remote secret status: ${errorMessage(error)}`);
        }
        return view;
    };
    const unlockSecrets = async (options) => {
        const config = await deps.configStore.read();
        const passphrase = resolvePassphrase(config, options.passphrase);
        if (passphrase === '')
            throw new SyncError('passphrase-required', '需要口令 / a passphrase is required');
        const prepared = await prepare({ signal: options.signal }, 'pull');
        const entry = prepared.remote.get('secrets')?.items['secrets'];
        if (entry === undefined || entry.deleted === true) {
            throw new SyncError('not-found', '存储中没有密钥包 / no secret envelope in the store');
        }
        const payload = await decryptSecrets(entry.value, { passphrase });
        return { ok: true, refCount: payload.refs.length, createdAt: entry.value.createdAt };
    };
    const inspectPlugin = async (spec) => {
        const manager = deps.services.pluginManager;
        if (manager === undefined || typeof manager.inspect !== 'function') {
            throw new SyncError('unsupported', '当前环境没有插件管理服务 / no plugin manager service');
        }
        const result = (await manager.inspect(spec));
        if (result.status === 'accepted') {
            return { accepted: true, kind: result.kind, name: result.name, version: result.version };
        }
        return { accepted: false, reason: result.reason ?? result.problem ?? 'refused' };
    };
    const invalidate = () => {
        snapshotCache = null;
        storeCache = null;
    };
    return {
        status,
        saveConfig,
        configView,
        testConnection,
        inventory,
        diff,
        backup,
        previewRestore,
        restore,
        previewSync,
        sync,
        history,
        listSnapshots,
        rollback,
        setAutoSync,
        logs,
        secretsStatus,
        unlockSecrets,
        inspectPlugin,
        invalidate,
        busy: () => runningOperation !== null,
        config: () => deps.configStore.read(),
    };
}
/** Whether one section is enabled by the configuration scopes. */
export function sectionEnabled(config, section) {
    switch (section) {
        case 'dsh-config':
            return config.scopes.dshConfig;
        case 'providers':
            return config.scopes.providers;
        case 'plugins':
            return config.scopes.plugins;
        case 'plugin-configs':
            return config.scopes.pluginConfigs;
        case 'secrets':
            return config.scopes.secrets;
        case 'mcp':
            return config.scopes.mcp;
        default:
            return false;
    }
}
/** Whether an action mutates this device. */
export function isLocalAction(kind) {
    return (kind === 'install-plugin' ||
        kind === 'upgrade-plugin' ||
        kind === 'downgrade-plugin' ||
        kind === 'enable-plugin' ||
        kind === 'disable-plugin' ||
        kind === 'remove-plugin' ||
        kind === 'write-plugin-config' ||
        kind === 'write-provider' ||
        kind === 'write-mcp' ||
        kind === 'write-dsh-config' ||
        kind === 'write-secret');
}
/** Whether an action mutates the store. */
export function isPushAction(kind) {
    return (kind === 'push-plugin' ||
        kind === 'push-plugin-config' ||
        kind === 'push-provider' ||
        kind === 'push-dsh-config' ||
        kind === 'push-mcp' ||
        kind === 'push-secret');
}
/** Build the new section documents for the actions a plan contains. */
function buildPushSections(input) {
    const sections = {};
    const bySection = new Map();
    for (const action of input.actions) {
        const list = bySection.get(action.section) ?? [];
        list.push(action);
        bySection.set(action.section, list);
    }
    for (const [section, actions] of bySection) {
        const existing = input.prepared.remote.get(section);
        const items = {};
        if (existing !== undefined) {
            for (const [id, item] of Object.entries(existing.items)) {
                items[id] = item;
            }
        }
        for (const action of actions) {
            const tombstone = action.kind === 'remove-remote-item';
            const value = tombstone ? (items[action.id]?.value ?? null) : (action.value ?? null);
            items[action.id] = {
                value: value,
                ...(tombstone ? { deleted: true } : {}),
                updatedAt: input.timestamp,
                updatedBy: input.device.name,
            };
        }
        sections[section] = {
            schemaVersion: SCHEMA_VERSION,
            profile: input.prepared.profile,
            section,
            revision: existing?.revision ?? 0,
            updatedAt: input.timestamp,
            items,
        };
    }
    return sections;
}
/** Reduce section documents to the compact snapshot shape. */
function snapshotSections(sections) {
    const out = {};
    for (const [section, document] of Object.entries(sections)) {
        const items = {};
        for (const [id, item] of Object.entries(document.items)) {
            items[id] = {
                value: item.value,
                ...(item.deleted === true ? { deleted: true } : {}),
                updatedAt: item.updatedAt,
                updatedBy: item.updatedBy,
            };
        }
        out[section] = items;
    }
    return out;
}
/** Rebuild one section against fresh store state after a concurrent write. */
function rebuildSection(mine, fresh) {
    if (fresh === undefined)
        return mine;
    // Keep this run's items, but start from the freshly read document so a
    // concurrent device's other items are preserved.
    const freshItems = fresh.items;
    const mineItems = mine.items;
    return {
        ...mine,
        revision: fresh.revision,
        items: { ...freshItems, ...mineItems },
    };
}
/** Build the device snapshot document stored under `devices/`. */
function buildDeviceDocument(device, snapshot, profile, updatedAt) {
    return {
        schemaVersion: SCHEMA_VERSION,
        device,
        profiles: { [profile]: snapshot },
        updatedAt,
    };
}
/** Compute the local baseline from the state both sides now agree on. */
function buildBaseline(profile, snapshot, remote, revision, updatedAt) {
    const sections = {};
    for (const section of SECTION_IDS) {
        if (section === 'secrets')
            continue;
        const local = localItemsFor(snapshot, section);
        const remoteItems = remoteItemsFor(remote.get(section), section);
        const ids = new Set([...local.keys(), ...remoteItems.keys()]);
        const entries = {};
        for (const id of ids) {
            const localItem = local.get(id);
            if (localItem === undefined) {
                // A store value this device has not applied yet must NOT enter the
                // baseline: otherwise the next run would read "local absent + baseline
                // present" as a local deletion and record a tombstone for an item this
                // device never had.
                continue;
            }
            const remoteItem = remoteItems.get(id);
            if (remoteItem !== undefined && localItem.hash !== remoteItem.hash)
                continue;
            entries[id] = { hash: localItem.hash, value: localItem.value };
        }
        sections[section] = entries;
    }
    return { profile, revision, updatedAt, sections };
}
/** Count the items one snapshot document holds. */
function countSnapshotItems(document) {
    let count = 0;
    for (const items of Object.values(document.sections)) {
        count += Object.keys(items ?? {}).length;
    }
    return count;
}
/** Default commit subject for a plan. */
function defaultMessage(plan) {
    const pushes = plan.actions.filter(action => isPushAction(action.kind)).length;
    const removals = plan.actions.filter(action => action.kind === 'remove-remote-item').length;
    const verb = plan.direction === 'push' ? 'backup' : 'sync';
    return `${TITLE_EN}: ${verb} ${pushes} item(s)${removals === 0 ? '' : `, ${removals} removal(s)`} from ${plan.profile}`;
}
/**
 * Merge a raw configuration patch (from the settings page) over the stored one.
 *
 * The page sends the complete object it renders, but a stale page must not erase
 * a field it did not know about, so only known keys are taken.
 */
function mergeRawConfig(current, input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        return current;
    const raw = input;
    const merged = {
        ...current,
        backendKind: raw.backendKind === 'git' || raw.backendKind === 'webdav' || raw.backendKind === 's3' ? raw.backendKind : current.backendKind,
        git: { ...current.git, ...(raw.git ?? {}) },
        webdav: { ...current.webdav, ...(raw.webdav ?? {}) },
        s3: { ...current.s3, ...(raw.s3 ?? {}) },
        scopes: { ...current.scopes, ...(raw.scopes ?? {}) },
        autoSync: { ...current.autoSync, ...(raw.autoSync ?? {}) },
        excluded: { ...current.excluded, ...(raw.excluded ?? {}) },
        profiles: Array.isArray(raw.profiles) ? raw.profiles : current.profiles,
        passphraseEnvVar: typeof raw.passphraseEnvVar === 'string' ? raw.passphraseEnvVar : current.passphraseEnvVar,
        deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : current.deviceName,
    };
    return merged;
}
/** Re-exported so the plugin entry can describe what it loaded. */
export const ENGINE_TITLES = { zh: TITLE_ZH, en: TITLE_EN };
/** Exported for tests. */
export { parseContents, hashOf, asConfigFile };
