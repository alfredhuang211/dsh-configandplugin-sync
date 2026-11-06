/**
 * Wire contract between the Host half and the browser half.
 *
 * Both halves import this one module, so a route name or payload shape can
 * never drift between them: the client's `post()` is typed by the same request
 * and response interfaces the Host handler implements.
 *
 * Every route is `POST` + JSON under {@link API_PREFIX} and answers with the
 * {@link ApiEnvelope} envelope, which the client parses once.
 * @module http/api-types
 */
/** Prefix every route shares. Kept literal so the client can be built standalone. */
export const API_PREFIX = '/api/dsh-configandplugin-sync';
