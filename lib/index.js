/**
 * Host entry of **DSH 配置与插件同步 / DSH Config & Plugin Sync**.
 *
 * Wires the platform pieces together and keeps itself inert when an optional
 * Host service is missing: the plugin never throws during profile boot, because
 * a thrown plugin load can take the whole DSH profile down.
 *
 * No runtime dependency on any `@deepseek-ai/*` package is used: services are
 * reached through `ctx.get()` / `ctx.inject()` and the browser half through the
 * Harness module table. This keeps the published plugin installable on a
 * Harness whose internals moved.
 * @module index
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR_NAME, DEFAULT_STORE_PATH, PACKAGE_NAME, TITLE_EN, TITLE_ZH } from './constants.js';
import { errorMessage } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { displayPath, resolveDshHome, resolveProfileName } from './core/paths.js';
import { createSnapshotCollector } from './collect/index.js';
import { createBackend } from './backends/index.js';
import { createEngine } from './engine/index.js';
import { registerHttpRoutes } from './http/routes.js';
import { createScheduler } from './scheduler.js';
import { registerTools } from './tools/tools.js';
import { ConfigStore, StateStore, createDeviceInfo, defaultState, ensureStoreDirs, normalizeConfig, resolveStorePaths, } from './state/store.js';
/** Cordis plugin name; equals the bundle row id and the npm package name. */
export const name = PACKAGE_NAME;
/** No hard service dependency: every service is feature-detected. */
export const inject = [];
/** Read this plugin's own version from its package manifest. */
async function readPluginVersion() {
    try {
        const manifestUrl = new URL('../package.json', import.meta.url);
        const text = await readFile(fileURLToPath(manifestUrl), 'utf8');
        const parsed = JSON.parse(text);
        return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
/**
 * Read the running DSH version.
 *
 * The desktop application and the `dsh` CLI package under the profile are
 * separate installs and can disagree, so the running application bundle is
 * asked first; a plain Node host fails those candidates and falls back to the
 * installed CLI package.
 */
async function readDshVersion(dshHome, profile) {
    const electron = process;
    const resources = typeof electron.resourcesPath === 'string' ? electron.resourcesPath : '';
    const asarIndex = process.argv.find(arg => arg.includes('app.asar'));
    const asarRoot = asarIndex === undefined ? '' : join(asarIndex.slice(0, asarIndex.indexOf('app.asar')), 'app.asar');
    const candidates = [
        ...(resources === '' ? [] : [{ path: join(resources, 'app.asar', 'package.json'), anyPackage: true }]),
        ...(asarRoot === '' ? [] : [{ path: join(asarRoot, 'package.json'), anyPackage: true }]),
        { path: join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), anyPackage: false },
        { path: join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), anyPackage: false },
        { path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), anyPackage: false },
    ];
    for (const candidate of candidates) {
        try {
            const text = await readFile(candidate.path, 'utf8');
            const parsed = JSON.parse(text);
            if (typeof parsed.version !== 'string')
                continue;
            if (candidate.anyPackage || parsed.name === '@deepseek-ai/dsh')
                return parsed.version;
        }
        catch {
            continue;
        }
    }
    return 'unknown';
}
/** Plugin entry point. */
export function apply(ctx) {
    let running = null;
    let disposed = false;
    const disposers = [];
    const start = async () => {
        const profileContext = ctx.get('profileContext');
        const dshHome = resolveDshHome(profileContext?.dir);
        const activeProfile = resolveProfileName(profileContext?.name, profileContext?.dir);
        const profilesRoot = join(dshHome, 'profiles');
        const paths = resolveStorePaths(dshHome);
        const pluginVersion = await readPluginVersion();
        const dshVersion = await readDshVersion(dshHome, activeProfile);
        const logger = createLogger({ filePath: paths.logPath, host: ctx.logger, ringSize: 500 });
        await ensureStoreDirs(paths);
        const services = {
            pluginManager: ctx.get('pluginManager'),
            configEditor: ctx.get('configEditor'),
            settings: ctx.get('settings'),
            credentials: ctx.get('credentials'),
            profileContext,
        };
        const availableProfiles = await listProfiles(profilesRoot, activeProfile);
        const configStore = new ConfigStore(paths.configPath, input => normalizeConfig(input, activeProfile, availableProfiles));
        const stateStore = new StateStore(paths.statePath, () => defaultState(deviceHolder.value));
        const initialConfig = await configStore.read();
        const initialState = await stateStore.read();
        const device = createDeviceInfo({
            existing: initialState.device,
            name: initialConfig.deviceName,
            dshVersion,
            pluginVersion,
        });
        deviceHolder.value = device;
        if (device.id !== initialState.device.id || device.name !== initialState.device.name) {
            initialState.device = device;
            await stateStore.write(initialState);
        }
        const collector = createSnapshotCollector({ device, services, logger });
        const engine = createEngine({
            logger,
            configStore,
            stateStore,
            paths,
            dshHome,
            profilesRoot,
            activeProfile,
            availableProfiles,
            pluginVersion,
            dshVersion,
            device,
            env: process.env,
            collector,
            services,
            createBackend: config => {
                const selected = selectBackendConfig(config);
                return createBackend(selected, {
                    workDir: join(paths.workDir, `${config.backendKind}-${activeProfile}`),
                    storePath: DEFAULT_STORE_PATH,
                    logger,
                    backupDir: join(paths.tempDir, 'backup'),
                    tokenProvider: async () => {
                        const name = config.git.tokenEnvVar.trim();
                        if (name === '')
                            return null;
                        const token = (process.env[name] ?? '').trim();
                        if (token === '')
                            return null;
                        const username = config.git.username.trim() !== '' ? config.git.username : defaultGitUsername(config.git.repoUrl);
                        return { username, token };
                    },
                });
            },
            onConfigChanged: next => {
                running?.scheduler.applyConfig(next);
            },
        });
        const scheduler = createScheduler({
            engine,
            logger,
            onFailure: message => logger.warn(`自动同步失败 / automatic sync failed: ${message}`),
            onSuccess: () => logger.debug('自动同步成功 / automatic sync succeeded'),
        });
        scheduler.applyConfig(initialConfig);
        running = { scheduler, engine, logger };
        disposers.push(ctx.inject(['tools'], scoped => registerTools({ ctx: scoped, engine, logger })));
        disposers.push(registerHttpRoutes({ ctx, engine, logger }));
        disposers.push(ctx.on('plugin-manager/changed', (() => {
            // Never throws into the Host: a change notification must not break the
            // operation that produced it.
            try {
                engine.invalidate();
                scheduler.notifyPluginChange();
            }
            catch (error) {
                logger.debug(`插件变更通知处理失败 / plugin-change notification failed: ${errorMessage(error)}`);
            }
        })));
        // Surface whether the tool registry is available, without failing the boot.
        const tools = ctx.get('tools');
        logger.info(`${TITLE_ZH} / ${TITLE_EN} 已加载`, {
            version: pluginVersion,
            dshVersion,
            profile: activeProfile,
            dataDir: displayPath(paths.dataDir),
            profiles: availableProfiles,
            pluginManager: services.pluginManager !== undefined,
            configEditor: services.configEditor !== undefined,
            toolService: tools !== undefined,
        });
        if (disposed)
            stop();
    };
    const stop = () => {
        running?.scheduler.dispose();
        running = null;
        for (const disposer of disposers.splice(0)) {
            try {
                void disposer();
            }
            catch {
                // The owning fiber tears down anyway.
            }
        }
    };
    ctx.effect(() => {
        void start().catch(error => {
            try {
                ctx.logger.error(`[${PACKAGE_NAME}] 加载失败 / failed to load: ${errorMessage(error)}`);
            }
            catch {
                // Nothing left to report to.
            }
        });
        return () => {
            disposed = true;
            stop();
        };
    }, `${PACKAGE_NAME}: lifecycle`);
}
/** Pick the configured backend block out of the whole plugin configuration. */
function selectBackendConfig(config) {
    if (config.backendKind === 'git')
        return config.git;
    if (config.backendKind === 'webdav')
        return config.webdav;
    return config.s3;
}
/** Default HTTPS username for well-known Git providers. */
function defaultGitUsername(repoUrl) {
    const lower = repoUrl.toLowerCase();
    if (lower.includes('github.com'))
        return 'x-access-token';
    if (lower.includes('gitlab'))
        return 'oauth2';
    if (lower.includes('gitea'))
        return 'git';
    return 'git';
}
/** Device identity must exist before the state store default is built. */
const deviceHolder = {
    value: { id: '', name: '', platform: process.platform, arch: process.arch, dshVersion: '', pluginVersion: '' },
};
/** List the profiles present in this DSH home, always including the active one. */
async function listProfiles(profilesRoot, activeProfile) {
    const names = new Set([activeProfile]);
    try {
        const { readdir, stat } = await import('node:fs/promises');
        const entries = await readdir(profilesRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            try {
                const info = await stat(join(profilesRoot, entry.name));
                if (!info.isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            names.add(entry.name);
        }
    }
    catch {
        // A home without a profiles directory is legal: only the active profile exists.
    }
    return [...names].sort();
}
/** Re-exported for tests and for a future service surface. */
export { apply as start, name as pluginName, createEngine, APP_DIR_NAME };
