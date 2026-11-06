/**
 * A single-flight mutex.
 *
 * Every mutating operation (backup, restore, sync, rollback) takes the same
 * lock: two of them writing the same work tree or the same profile patch would
 * corrupt both, and the settings page and an agent tool can be triggered at the
 * same moment.
 * @module core/mutex
 */
/** A mutex whose holder is reported, so a "busy" error can name the owner. */
export interface Mutex {
    /** Try to acquire without waiting; returns a release function or null. */
    tryAcquire(owner: string): (() => void) | null;
    /** Owner of the current hold, or null. */
    holder(): string | null;
    /** Run `task` while holding the lock; waits for the current holder. */
    run<T>(owner: string, task: () => Promise<T>): Promise<T>;
}
/** Create one mutex. */
export declare function createMutex(): Mutex;
