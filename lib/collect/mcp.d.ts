/**
 * MCP server collection.
 *
 * One `@deepseek-ai/dsh-mcp-client` Loader entry defines one MCP server. This
 * module turns each entry into a {@link McpServerRecord} that is enough to
 * re-create the server on another device *without* carrying secret material:
 * the transport, how the server program is obtained (npx / uvx / pip / npm /
 * docker / binary / HTTP), the package and its pinned version, the arguments
 * with credential values masked, and only the *names* of headers and
 * environment variables — never their values.
 *
 * `headerNames`/`envNames` are names for the same reason a provider records
 * `apiKeyEnv` instead of the key: the value is the secret, the name is the
 * contract.
 * @module collect/mcp
 */
import type { ConfigEntryRecord, JsonObject, McpInstallMethod, McpServerRecord } from '../types.js';
/** Module name of the MCP client bridge plugin. */
export declare const MCP_CLIENT_MODULE = "@deepseek-ai/dsh-mcp-client";
/** Result of collecting one profile's MCP servers. */
export interface McpCollectResult {
    servers: McpServerRecord[];
    warnings: string[];
}
/** Options of {@link collectMcpServers}. */
export interface McpCollectOptions {
    /** Warnings sink; the caller owns logging. */
    warnings?: string[];
}
/** A parsed package/image reference. */
interface PackageSpec {
    name: string;
    version?: string;
}
/** Infer how the MCP server program is obtained and started. */
export declare function inferInstallMethod(transport: McpServerRecord['transport'], config: JsonObject): McpInstallMethod;
/**
 * Parse one package/image reference.
 *
 * Supports `pkg`, `@scope/pkg`, `pkg@1.2.3`, `@scope/pkg@latest`,
 * `pkg==1.2.3` (pip) and `registry/owner/image:tag` (docker).
 */
export declare function parsePackageSpec(specInput: string): PackageSpec | null;
/** Find the package/image a command invocation names, if any. */
export declare function findPackageSpec(command: string, args: readonly string[]): PackageSpec | null;
/** Mask secret-looking values in one argument list. */
export declare function redactArgs(args: readonly string[]): string[];
/**
 * Collect every MCP server entry of one profile.
 *
 * Duplicate `serverName` declarations (two entries pointing at the same
 * namespace) collapse to the last one, matching how the Loader resolves a
 * repeated namespace; a warning names the server but never a value.
 */
export declare function collectMcpServers(entries: readonly ConfigEntryRecord[], options?: McpCollectOptions): McpCollectResult;
export {};
