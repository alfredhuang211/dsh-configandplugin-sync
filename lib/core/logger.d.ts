/**
 * Logger with a file sink and an in-memory ring buffer.
 *
 * Every line passes {@link redactText} before it reaches a sink: this plugin
 * handles API keys and storage credentials, so a log file must not become the
 * leak that the synchronized store was encrypted to prevent.
 * @module core/logger
 */
import type { SyncLogger } from '../types.js';
/** Minimal host logger surface. */
interface HostLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/** Options of {@link createLogger}. */
export interface LoggerOptions {
    /** Append-only log file; created on first write. */
    filePath: string;
    /** Host logger mirrored below the file sink. */
    host?: HostLogger | undefined;
    /** Ring buffer capacity for the settings page. */
    ringSize?: number;
    /** Cap on one appended detail payload, in characters. */
    maxDetailChars?: number;
}
/** Logger plus the extras the HTTP surface needs. */
export interface FileSyncLogger extends SyncLogger {
    /** Absolute path of the log file (for display). */
    readonly filePath: string;
    /** Flush pending asynchronous appends; resolves when the queue is empty. */
    flush(): Promise<void>;
}
/**
 * Create one process-wide logger.
 *
 * Writes are serialized through a single promise chain so two lines can never
 * interleave, and a failed append is swallowed (a full disk must not fail the
 * sync that was being logged).
 */
export declare function createLogger(options: LoggerOptions): FileSyncLogger;
/** A logger that discards everything; used by tests and dry runs. */
export declare function createNullLogger(): FileSyncLogger;
export {};
