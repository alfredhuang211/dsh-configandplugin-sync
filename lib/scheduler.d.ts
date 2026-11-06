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
import type { SyncConfig, SyncLogger } from './types.js';
import type { SyncEngine } from './engine/index.js';
/** Scheduling surface used by the plugin entry. */
export interface AutoSyncScheduler {
    /** Apply the configuration; safe to call repeatedly. */
    applyConfig(config: SyncConfig): void;
    /** Queue a debounced run after a plugin change. */
    notifyPluginChange(): void;
    /** Stop every timer and drop the pending debounce. */
    dispose(): void;
    /** Whether a run is currently scheduled or executing. */
    status(): {
        scheduled: boolean;
        nextRunAt: string | null;
        failures: number;
    };
}
/** Options of {@link createScheduler}. */
export interface SchedulerOptions {
    engine: SyncEngine;
    logger: SyncLogger;
    onFailure?: (message: string) => void;
    onSuccess?: () => void;
    now?: () => Date;
}
/** Create the automatic synchronizer. */
export declare function createScheduler(options: SchedulerOptions): AutoSyncScheduler;
