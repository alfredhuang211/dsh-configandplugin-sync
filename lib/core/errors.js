/**
 * Typed errors with a stable wire code.
 *
 * The HTTP surface and the agent tools both map {@link SyncError.code} onto
 * their own envelope, so a caller can branch on a code instead of a message
 * that is translated per locale.
 * @module core/errors
 */
/** An error carrying a stable code plus optional lossless-JSON details. */
export class SyncError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'SyncError';
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}
/** Read `error.message` from an unknown throwable. */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
/** Narrow any throwable to a {@link SyncError}, keeping a known code. */
export function toSyncError(error) {
    if (error instanceof SyncError)
        return error;
    const message = errorMessage(error);
    const coded = error;
    const code = coded?.code;
    if (typeof code === 'string' && isSyncErrorCode(code)) {
        return new SyncError(code, message);
    }
    // Node's fetch aborts surface as `AbortError`.
    if (coded?.name === 'AbortError')
        return new SyncError('cancelled', '操作已取消 / operation cancelled');
    return new SyncError('internal', message);
}
/** Whether a string is one of the declared codes. */
export function isSyncErrorCode(value) {
    return (value === 'not-configured' ||
        value === 'invalid-config' ||
        value === 'unsupported-backend' ||
        value === 'auth-required' ||
        value === 'auth-failed' ||
        value === 'network' ||
        value === 'not-found' ||
        value === 'conflict' ||
        value === 'conflict-present' ||
        value === 'confirmation-required' ||
        value === 'passphrase-required' ||
        value === 'passphrase-invalid' ||
        value === 'read-only' ||
        value === 'busy' ||
        value === 'cancelled' ||
        value === 'unsupported' ||
        value === 'internal');
}
