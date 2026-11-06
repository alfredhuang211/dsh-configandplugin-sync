/**
 * Structural types for the DeepSeek Harness host APIs this plugin uses.
 *
 * Deliberately structural: the plugin declares no runtime dependency on any
 * `@deepseek-ai/*` package, so it keeps loading when a Harness release moves an
 * internal module. Only the surface declared here is read, and every optional
 * member is feature-detected before use.
 *
 * The method lists were confirmed against the running DSH 0.2.2-rc.1 with
 * `cordis_inspect_query` (`Service`) rather than guessed.
 * @module dsh
 */
export {};
