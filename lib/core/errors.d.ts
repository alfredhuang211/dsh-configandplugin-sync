/**
 * Typed errors with a stable wire code.
 *
 * The HTTP surface and the agent tools both map {@link SyncError.code} onto
 * their own envelope, so a caller can branch on a code instead of a message
 * that is translated per locale.
 * @module core/errors
 */
/** Every failure this plugin reports deliberately. */
export type SyncErrorCode = 'not-configured' | 'invalid-config' | 'unsupported-backend' | 'auth-required' | 'auth-failed' | 'network' | 'not-found' | 'conflict' | 'conflict-present' | 'confirmation-required' | 'passphrase-required' | 'passphrase-invalid' | 'read-only' | 'busy' | 'cancelled' | 'unsupported' | 'internal';
/** An error carrying a stable code plus optional lossless-JSON details. */
export declare class SyncError extends Error {
    readonly code: SyncErrorCode;
    readonly details?: unknown;
    constructor(code: SyncErrorCode, message: string, details?: unknown);
}
/** Read `error.message` from an unknown throwable. */
export declare function errorMessage(error: unknown): string;
/** Narrow any throwable to a {@link SyncError}, keeping a known code. */
export declare function toSyncError(error: unknown): SyncError;
/** Whether a string is one of the declared codes. */
export declare function isSyncErrorCode(value: string): value is SyncErrorCode;
