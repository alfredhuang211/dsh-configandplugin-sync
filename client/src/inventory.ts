/**
 * Pure helpers over the `inventory` payload.
 *
 * The Plugins and MCP tabs only read this response, so the filtering and label
 * decisions live here (DOM-free and unit tested) and the components stay thin.
 * Header and environment variable *names* are all this data carries: their
 * values are secret material and are stripped Host-side before the page sees
 * anything.
 * @module inventory
 */

import type { InventoryMcpRow, InventoryPluginRow, InventoryResponse } from '../../src/http/api-types.js'

/** Rows of one inventory response, or an empty list before it arrives. */
export function pluginRows(response: InventoryResponse | null): InventoryPluginRow[] {
  return response === null ? [] : response.plugins
}

/** MCP rows of one inventory response, or an empty list before it arrives. */
export function mcpRows(response: InventoryResponse | null): InventoryMcpRow[] {
  return response === null ? [] : response.mcp
}

/** Providers of one inventory response, or an empty list. */
export function providerRows(response: InventoryResponse | null): InventoryResponse['providers'] {
  return response === null ? [] : response.providers
}

/** Case-insensitive filter over the columns the Plugins tab shows. */
export function filterPlugins(
  rows: readonly InventoryPluginRow[],
  query: string,
): InventoryPluginRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter(row => {
    const haystack = [row.name, row.id, row.version ?? '', row.origin, row.installSpec ?? '']
      .join('\n')
      .toLowerCase()
    return haystack.includes(needle)
  })
}

/** How many listed plugins are enabled (used by the header summary). */
export function countEnabledPlugins(rows: readonly InventoryPluginRow[]): number {
  return rows.filter(row => row.enabled).length
}

/** How many listed plugins can be restored on another device. */
export function countRestorablePlugins(rows: readonly InventoryPluginRow[]): number {
  return rows.filter(row => row.restorable).length
}

/**
 * Where an MCP server runs: a URL for HTTP transports, the command line for
 * stdio ones. Empty when the row carries neither.
 */
export function mcpEndpoint(row: InventoryMcpRow): string {
  const url = (row.url ?? '').trim()
  if (url !== '') return url
  const command = (row.command ?? '').trim()
  return command
}

/** `name@version`, `name`, or an empty string when the row names no package. */
export function mcpPackageLabel(row: InventoryMcpRow): string {
  const name = (row.packageName ?? '').trim()
  const version = (row.packageVersion ?? '').trim()
  if (name === '') return ''
  return version === '' ? name : `${name}@${version}`
}

/** Names of MCP header variables, sorted for a stable list. */
export function mcpHeaderNames(row: InventoryMcpRow): string[] {
  return [...row.headerNames].filter(name => name.trim() !== '')
}

/** Names of MCP environment variables, sorted for a stable list. */
export function mcpEnvNames(row: InventoryMcpRow): string[] {
  return [...row.envNames].filter(name => name.trim() !== '')
}
