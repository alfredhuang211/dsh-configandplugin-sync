/**
 * Host-side HTTP routes for the Web settings page.
 *
 * Routes are registered on the Host connection's authenticated shared channel
 * (`connection.fetch.register`), so they inherit the deployment's Host/Origin
 * fence and browser authentication instead of inventing a second gate. Every
 * route is POST + JSON and answers with one envelope, `{ ok, value }` or
 * `{ ok, error }`, which the client parses once.
 *
 * Two rules are enforced here rather than in the page:
 *
 *  - **Secrets never travel to the browser.** The four storage credentials are
 *    blanked in every response, and an empty value coming back means "keep the
 *    stored one" — the page cannot overwrite a password it was never shown.
 *  - **A destructive plan is two-phase.** The engine refuses to execute
 *    without `confirmDestructive`, and an unresolved conflict refuses too; both
 *    refusals carry the plan so the page can render the decision.
 * @module http/routes
 */
import { SyncError, errorMessage, toSyncError } from '../core/errors.js';
import { API_PREFIX } from './api-types.js';
/** Maximum JSON body accepted by one route. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Secret fields that are blanked before a configuration leaves the process. */
const SECRET_FIELDS = [
    ['webdav', 'password'],
    ['webdav', 'token'],
    ['s3', 'secretAccessKey'],
    ['s3', 'sessionToken'],
];
/** Whether a thrown error is a `SyncError`. */
function isSyncError(error) {
    return error instanceof SyncError;
}
/** JSON response helper. */
function json(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
        },
    });
}
/** Error envelope. */
function failure(error) {
    const apiError = { code: error.code, message: error.message };
    if (error.details !== undefined)
        apiError.details = error.details;
    return json({ ok: false, error: apiError });
}
/** Read and validate one JSON body. */
async function readBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
        throw new SyncError('invalid-config', '请求内容过大 / request body too large');
    }
    if (text.trim() === '')
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new SyncError('invalid-config', '请求内容不是合法 JSON / request body is not JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyncError('invalid-config', '请求内容必须是 JSON 对象 / request body must be a JSON object');
    }
    return parsed;
}
/** Blank every storage credential in a configuration view. */
export function blankSecrets(view) {
    const next = {
        ...view,
        webdav: { ...view.webdav, password: '', token: '' },
        s3: { ...view.s3, secretAccessKey: '', sessionToken: '' },
    };
    return next;
}
/**
 * Re-fill blanked credentials from the stored configuration.
 *
 * The settings page sends the whole object back; an empty secret field means
 * "unchanged", so the stored value is substituted before normalization. A user
 * clearing a credential on purpose clears it through the local config file,
 * not through a page that never displayed the value.
 */
export function restoreBlankedSecrets(input, stored) {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        return input;
    const record = { ...input };
    for (const [path, key] of SECRET_FIELDS) {
        const block = record[path];
        if (block === null || typeof block !== 'object' || Array.isArray(block))
            continue;
        const field = { ...block };
        if (field[key] === '') {
            field[key] = stored[path][key];
            record[path] = field;
        }
    }
    return record;
}
/** Register every route; returns a disposer removing all of them. */
export function registerHttpRoutes(options) {
    const disposers = [];
    const routeDisposer = options.ctx.inject(['connection'], scoped => {
        const connection = scoped.get('connection');
        const fetchRegistry = connection?.fetch;
        if (fetchRegistry === undefined || typeof fetchRegistry.register !== 'function') {
            options.logger.warn('Web 设置页不可用：缺少 connection 服务 / settings page unavailable: no connection service');
            return;
        }
        const handlers = {
            status: async (body) => {
                const view = await options.engine.status({ refresh: body.refresh === true });
                return { ...view, config: blankSecrets(view.config) };
            },
            'config/save': async (body) => {
                const stored = await options.engine.config();
                const submitted = body.config;
                const view = await options.engine.saveConfig(restoreBlankedSecrets(submitted, stored));
                return { config: blankSecrets(view) };
            },
            'connection/test': async (body) => {
                const request = body;
                if (request.config !== undefined) {
                    const stored = await options.engine.config();
                    const config = restoreBlankedSecrets(request.config, stored);
                    return options.engine.testConnection({ config });
                }
                return options.engine.testConnection();
            },
            'sections/list': async () => {
                const view = await options.engine.status({});
                return { sections: view.sections };
            },
            inventory: async (body) => options.engine.inventory(typeof body.profile === 'string' ? body.profile : undefined),
            diff: async (body) => {
                const request = body;
                const result = await options.engine.diff({
                    direction: request.direction === 'push' || request.direction === 'pull' || request.direction === 'two-way'
                        ? request.direction
                        : 'two-way',
                    profile: request.profile,
                });
                return result;
            },
            backup: async (body) => {
                const request = body;
                return {
                    result: await options.engine.backup({
                        message: typeof request.message === 'string' ? request.message : undefined,
                        confirmDestructive: request.confirmDestructive === true,
                        profile: request.profile,
                    }),
                };
            },
            'restore/preview': async (body) => {
                const request = body;
                return options.engine.previewRestore({ profile: request.profile, refresh: request.refresh === true });
            },
            restore: async (body) => {
                const request = body;
                return {
                    result: await options.engine.restore({
                        resolutions: asResolutions(request.resolutions),
                        confirmDestructive: request.confirmDestructive === true,
                        profile: request.profile,
                        itemIds: asStringArray(request.itemIds),
                    }),
                };
            },
            'sync/preview': async (body) => {
                const request = body;
                return options.engine.previewSync({ profile: request.profile, refresh: request.refresh === true });
            },
            sync: async (body) => {
                const request = body;
                return {
                    result: await options.engine.sync({
                        resolutions: asResolutions(request.resolutions),
                        confirmDestructive: request.confirmDestructive === true,
                        profile: request.profile,
                    }),
                };
            },
            history: async (body) => options.engine.history({ limit: typeof body.limit === 'number' ? body.limit : undefined }),
            rollback: async (body) => {
                const request = body;
                if (typeof request.revision !== 'string' || request.revision.trim() === '') {
                    throw new SyncError('invalid-config', '缺少快照标识 / a snapshot path is required');
                }
                return {
                    result: await options.engine.rollback({
                        revision: request.revision,
                        resolutions: asResolutions(request.resolutions),
                        confirmDestructive: request.confirmDestructive === true,
                    }),
                };
            },
            'auto-sync': async (body) => {
                const request = body;
                const view = await options.engine.setAutoSync({
                    ...(typeof request.enabled === 'boolean' ? { enabled: request.enabled } : {}),
                    ...(request.mode === 'two-way' || request.mode === 'backup' || request.mode === 'restore'
                        ? { mode: request.mode }
                        : {}),
                    ...(typeof request.intervalMinutes === 'number' ? { intervalMinutes: request.intervalMinutes } : {}),
                    ...(typeof request.startupDelayMs === 'number' ? { startupDelayMs: request.startupDelayMs } : {}),
                    ...(typeof request.onStartup === 'boolean' ? { onStartup: request.onStartup } : {}),
                    ...(typeof request.onPluginChange === 'boolean' ? { onPluginChange: request.onPluginChange } : {}),
                    ...(typeof request.debounceMs === 'number' ? { debounceMs: request.debounceMs } : {}),
                });
                return { config: blankSecrets(view) };
            },
            logs: async (body) => options.engine.logs({ limit: typeof body.limit === 'number' ? body.limit : undefined }),
            'secrets/status': async () => options.engine.secretsStatus({}),
            'secrets/unlock': async (body) => options.engine.unlockSecrets({ passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined }),
            'plugin/inspect': async (body) => {
                const request = body;
                if (typeof request.spec !== 'string' || request.spec.trim() === '') {
                    throw new SyncError('invalid-config', '缺少安装规格 / an install spec is required');
                }
                return options.engine.inspectPlugin(request.spec.trim());
            },
            snapshots: async (body) => ({ entries: await options.engine.listSnapshots({ profile: typeof body.profile === 'string' ? body.profile : undefined }) }),
        };
        for (const [name, handler] of Object.entries(handlers)) {
            const path = `${API_PREFIX}/${name}`;
            disposers.push(fetchRegistry.register({
                path,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: async (request) => {
                    try {
                        const body = await readBody(request);
                        if (request.signal.aborted) {
                            return failure(new SyncError('cancelled', '请求已取消 / request cancelled'));
                        }
                        const value = await handler(body);
                        return json({ ok: true, value });
                    }
                    catch (error) {
                        const syncError = isSyncError(error) ? error : toSyncError(error);
                        if (syncError.code === 'internal') {
                            options.logger.error(`API 失败 / API failure: ${name}: ${syncError.message}`);
                        }
                        else {
                            options.logger.debug(`API 拒绝 / API refusal: ${name}: ${syncError.code}`);
                        }
                        return failure(syncError);
                    }
                },
            }));
        }
        options.logger.info(`已注册 ${Object.keys(handlers).length} 个设置页接口 / registered settings-page routes`);
    });
    return () => {
        void routeDisposer();
        for (const disposer of disposers.splice(0)) {
            try {
                void disposer();
            }
            catch {
                // Disposal is best-effort; the owning fiber already tears down.
            }
        }
    };
}
/** Parse user conflict decisions. */
function asResolutions(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = [];
    for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item))
            continue;
        const raw = item;
        if (typeof raw.id !== 'string' || raw.id === '')
            continue;
        if (raw.choice !== 'local' && raw.choice !== 'remote' && raw.choice !== 'skip')
            continue;
        if (raw.section !== 'dsh-config' &&
            raw.section !== 'providers' &&
            raw.section !== 'plugins' &&
            raw.section !== 'plugin-configs' &&
            raw.section !== 'secrets' &&
            raw.section !== 'mcp') {
            continue;
        }
        out.push({ section: raw.section, id: raw.id, choice: raw.choice });
    }
    return out.length === 0 ? undefined : out;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = value.filter((item) => typeof item === 'string' && item.trim() !== '');
    return out.length === 0 ? undefined : out;
}
/** Exported for tests: map any throwable to the wire envelope. */
export function toErrorEnvelope(error) {
    if (error instanceof SyncError) {
        return {
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                ...(error.details === undefined ? {} : { details: error.details }),
            },
        };
    }
    return { ok: false, error: { code: 'internal', message: errorMessage(error) } };
}
/** Exported for tests: a plain connectivity result from an unknown throwable. */
export function connectionFailure(kind, error) {
    return {
        ok: false,
        at: new Date().toISOString(),
        kind,
        revision: null,
        message: errorMessage(error),
    };
}
