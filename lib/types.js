/**
 * Domain model shared by the collectors, storage backends, sync engine, HTTP
 * surface, agent tools and the Web settings page.
 *
 * Three layers are kept apart on purpose:
 *
 *  - a **snapshot** is what one device looks like (`ProfileSnapshot`);
 *  - a **remote section** is the shared desired state stored in the backend,
 *    one document per section, with tombstones and the device that wrote it;
 *  - a **plan** is the difference between the two plus the actions that would
 *    close it, always previewable before anything is written.
 *
 * Everything is versioned by {@link SCHEMA_VERSION} so a future release can
 * migrate an existing store rather than guess at its shape.
 * @module types
 */
/** Bump when a stored document changes shape in a way older readers cannot read. */
export const SCHEMA_VERSION = 1;
/** Every section, in the order the settings page lists them. */
export const SECTION_IDS = [
    'dsh-config',
    'providers',
    'plugins',
    'plugin-configs',
    'secrets',
    'mcp',
];
/** Human-readable English labels, used by the headless half (logs, tools). */
export const SECTION_LABELS = {
    'dsh-config': 'DSH configuration',
    providers: 'Model providers',
    plugins: 'Plugin inventory',
    'plugin-configs': 'Plugin configuration',
    secrets: 'Secrets and keys',
    mcp: 'MCP servers',
};
/** Default scopes: everything except secrets, which need a passphrase first. */
export function defaultScopes() {
    return {
        dshConfig: true,
        providers: true,
        plugins: true,
        pluginConfigs: true,
        secrets: false,
        mcp: true,
    };
}
