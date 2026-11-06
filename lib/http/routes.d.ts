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
import type { ApiError } from './api-types.js';
import type { DshContext, DshDisposer } from '../dsh.js';
import type { SyncEngine } from '../engine/index.js';
import type { ConnectionTestResult, SyncConfig, SyncConfigView, SyncLogger } from '../types.js';
/** Blank every storage credential in a configuration view. */
export declare function blankSecrets(view: SyncConfigView): SyncConfigView;
/**
 * Re-fill blanked credentials from the stored configuration.
 *
 * The settings page sends the whole object back; an empty secret field means
 * "unchanged", so the stored value is substituted before normalization. A user
 * clearing a credential on purpose clears it through the local config file,
 * not through a page that never displayed the value.
 */
export declare function restoreBlankedSecrets(input: unknown, stored: SyncConfig): unknown;
/** Register every route; returns a disposer removing all of them. */
export declare function registerHttpRoutes(options: {
    ctx: DshContext;
    engine: SyncEngine;
    logger: SyncLogger;
}): DshDisposer;
/** Exported for tests: map any throwable to the wire envelope. */
export declare function toErrorEnvelope(error: unknown): {
    ok: false;
    error: ApiError;
};
/** Exported for tests: a plain connectivity result from an unknown throwable. */
export declare function connectionFailure(kind: ConnectionTestResult['kind'], error: unknown): ConnectionTestResult;
