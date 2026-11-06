/**
 * Automatic synchronization.
 *
 * Three triggers, one queue: a startup run, a periodic timer, and a debounced
 * run after DSH reports a plugin change. Only one automatic run is ever in
 * flight — an interval that fires during a long restore is skipped rather than
 * queued, because queueing would multiply the work instead of catching up.
 *
 * Consecutive failures back the next attempt off exponentially, so a backend
 * that is down does not produce one failed git operation per interval forever.
 * @module scheduler
 */
import { SyncError, errorMessage } from './core/errors.js';
/** Longest backoff between automatic attempts. */
const MAX_BACKOFF_MS = 60 * 60_000;
/** Runs before the backoff saturates. */
const BACKOFF_STEPS = 5;
/** Create the automatic synchronizer. */
export function createScheduler(options) {
    const logger = options.logger;
    const now = options.now ?? (() => new Date());
    let config = null;
    let mode = 'git';
    let intervalHandle = null;
    let startupHandle = null;
    let debounceHandle = null;
    let backoffHandle = null;
    let running = false;
    let disposed = false;
    let failures = 0;
    let nextRunAt = null;
    const clear = () => {
        if (intervalHandle !== null)
            clearInterval(intervalHandle);
        if (startupHandle !== null)
            clearTimeout(startupHandle);
        if (debounceHandle !== null)
            clearTimeout(debounceHandle);
        if (backoffHandle !== null)
            clearTimeout(backoffHandle);
        intervalHandle = null;
        startupHandle = null;
        debounceHandle = null;
        backoffHandle = null;
        nextRunAt = null;
    };
    const scheduleBackoff = () => {
        const base = (config?.intervalMinutes ?? 30) * 60_000;
        const step = Math.min(BACKOFF_STEPS, Math.max(1, failures));
        const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** (step - 1));
        if (backoffHandle !== null)
            clearTimeout(backoffHandle);
        nextRunAt = new Date(now().getTime() + delay);
        logger.warn(`自动同步失败，将在 ${Math.round(delay / 60_000)} 分钟后重试 / automatic sync backs off`);
        backoffHandle = setTimeout(() => {
            backoffHandle = null;
            void run('retry');
        }, delay);
        unref(backoffHandle);
    };
    const run = async (trigger) => {
        if (disposed)
            return;
        if (running) {
            logger.debug(`跳过自动同步（正在执行）/ skipping an automatic run: one is already running (${trigger})`);
            return;
        }
        const active = config;
        if (active === null || !active.enabled)
            return;
        if (options.engine.busy()) {
            logger.debug('跳过自动同步（手动操作进行中）/ skipping an automatic run: a manual operation is running');
            return;
        }
        running = true;
        nextRunAt = null;
        try {
            logger.info(`自动同步开始 / automatic sync started (${trigger}, ${active.mode})`);
            const operation = active.mode === 'backup'
                ? await options.engine.backup({ confirmDestructive: false })
                : active.mode === 'restore'
                    ? await options.engine.restore({ confirmDestructive: false })
                    : await options.engine.sync({ confirmDestructive: false });
            if (operation.ok) {
                failures = 0;
                options.onSuccess?.();
                logger.info('自动同步完成 / automatic sync finished', {
                    revision: operation.revision,
                    pushed: operation.pushed,
                    actions: operation.actionOutcomes.length,
                });
            }
            else {
                failures += 1;
                options.onFailure?.(operation.error ?? 'unknown error');
                scheduleBackoff();
            }
        }
        catch (error) {
            const syncError = error instanceof SyncError ? error : new SyncError('internal', errorMessage(error));
            if (syncError.code === 'conflict-present' || syncError.code === 'confirmation-required') {
                // A conflict is a decision, not a failure: retrying automatically would
                // never resolve it, so the run pauses until the user acts.
                logger.warn('自动同步暂停：存在冲突或需要确认 / automatic sync paused: a conflict needs a decision');
                options.onFailure?.(syncError.message);
                return;
            }
            failures += 1;
            options.onFailure?.(syncError.message);
            logger.warn(`自动同步失败 / automatic sync failed: ${syncError.message}`);
            scheduleBackoff();
        }
        finally {
            running = false;
        }
    };
    const applyConfig = (next) => {
        if (disposed)
            return;
        mode = next.backendKind;
        const auto = next.autoSync;
        const previous = config;
        config = auto;
        clear();
        if (!auto.enabled) {
            logger.debug('自动同步已关闭 / automatic sync is off');
            return;
        }
        if (auto.onStartup && previous?.enabled !== true) {
            startupHandle = setTimeout(() => {
                startupHandle = null;
                void run('startup');
            }, Math.max(0, auto.startupDelayMs));
            unref(startupHandle);
            nextRunAt = new Date(now().getTime() + auto.startupDelayMs);
        }
        if (auto.intervalMinutes > 0) {
            const period = auto.intervalMinutes * 60_000;
            intervalHandle = setInterval(() => {
                nextRunAt = new Date(now().getTime() + period);
                void run('interval');
            }, period);
            unref(intervalHandle);
            if (nextRunAt === null)
                nextRunAt = new Date(now().getTime() + period);
        }
        logger.info(`自动同步已启用 / automatic sync enabled`, {
            mode: auto.mode,
            intervalMinutes: auto.intervalMinutes,
            backend: mode,
        });
    };
    const notifyPluginChange = () => {
        if (disposed)
            return;
        const auto = config;
        if (auto === null || !auto.enabled || !auto.onPluginChange)
            return;
        if (debounceHandle !== null)
            clearTimeout(debounceHandle);
        debounceHandle = setTimeout(() => {
            debounceHandle = null;
            void run('plugin-change');
        }, Math.max(500, auto.debounceMs));
        unref(debounceHandle);
    };
    const dispose = () => {
        disposed = true;
        clear();
        config = null;
    };
    return {
        applyConfig,
        notifyPluginChange,
        dispose,
        status: () => ({
            scheduled: nextRunAt !== null,
            nextRunAt: nextRunAt === null ? null : nextRunAt.toISOString(),
            failures,
        }),
    };
}
/** Keep a timer from holding the process open. */
function unref(handle) {
    const candidate = handle;
    candidate.unref?.();
}
