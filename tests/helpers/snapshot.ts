/**
 * Snapshot fixtures for the engine tests.
 *
 * A `ProfileSnapshot` is the only input the plan builder takes, so tests can
 * describe a device declaratively instead of building a fake DSH home.
 * @module tests/helpers/snapshot
 */

import type {
  ConfigFileRecord,
  DeviceInfo,
  DshConfigRecord,
  McpServerRecord,
  PluginRecord,
  PluginConfigRecord,
  ProfileSnapshot,
  ProviderRecord,
} from '../../src/types.js'
import { SCHEMA_VERSION } from '../../src/types.js'
import { sha256Text } from '../../src/core/hash.js'

/** One file a fixture should contain. */
export interface ConfigFileInput {
  path: string
  content: string
  kind?: ConfigFileRecord['kind']
}

/** Options of {@link makeSnapshot}. */
export interface SnapshotInput {
  profile?: string
  files?: ConfigFileInput[]
  providers?: Partial<ProviderRecord>[]
  plugins?: Partial<PluginRecord>[]
  pluginConfigs?: Partial<PluginConfigRecord>[]
  mcp?: Partial<McpServerRecord>[]
  deviceName?: string
}

/** A fixed device for deterministic tests. */
export function testDevice(name = 'test-device'): DeviceInfo {
  return {
    id: 'dev_test0000000000000000',
    name,
    platform: 'darwin',
    arch: 'arm64',
    dshVersion: '0.2.2-rc.1',
    pluginVersion: '0.1.0',
  }
}

/** Build one configuration file record. */
export function makeConfigFile(input: ConfigFileInput): ConfigFileRecord {
  return {
    path: input.path,
    kind: input.kind ?? (input.path.endsWith('cordis.patch.yml') ? 'profile-patch' : 'profile-cordis'),
    sha256: sha256Text(input.content),
    size: Buffer.byteLength(input.content, 'utf8'),
    content: input.content,
  }
}

/** Build a whole snapshot from terse inputs. */
export function makeSnapshot(input: SnapshotInput = {}): ProfileSnapshot {
  const profile = input.profile ?? 'desktop'
  const files = (input.files ?? [
    {
      path: `profiles/${profile}/cordis.patch.yml`,
      content: '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n',
    },
  ]).map(makeConfigFile)

  const dsh: DshConfigRecord = {
    profile,
    files,
    entries: [],
    bundles: [],
    dependencies: {},
    warnings: [],
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    profile,
    device: testDevice(input.deviceName),
    generatedAt: new Date(0).toISOString(),
    dsh,
    providers: (input.providers ?? []).map((provider, index) => ({
      id: provider.id ?? `provider-${index}`,
      entryId: provider.entryId ?? 'llm-pi-ai',
      displayName: provider.displayName,
      api: provider.api,
      baseURL: provider.baseURL,
      apiKeyEnv: provider.apiKeyEnv,
      models: provider.models ?? ['m1'],
      extra: provider.extra ?? {},
    })),
    defaultModel: null,
    plugins: (input.plugins ?? []).map((plugin, index) => ({
      id: plugin.id ?? plugin.name ?? `plugin-${index}`,
      name: plugin.name ?? `plugin-${index}`,
      displayName: plugin.displayName,
      version: plugin.version ?? '1.0.0',
      origin: plugin.origin ?? 'npm',
      source: plugin.source,
      installSpec: plugin.installSpec ?? `${plugin.name ?? `plugin-${index}`}@${plugin.version ?? '1.0.0'}`,
      installMethod: plugin.installMethod,
      enabled: plugin.enabled ?? true,
      builtIn: plugin.builtIn ?? false,
      syncable: plugin.syncable ?? true,
      restorable: plugin.restorable ?? true,
      profile,
      platform: 'darwin',
      rows: plugin.rows ?? [],
      error: plugin.error,
    })),
    pluginConfigs: (input.pluginConfigs ?? []).map((config, index) => ({
      pluginId: config.pluginId ?? `plugin-${index}`,
      moduleName: config.moduleName ?? `plugin-${index}`,
      entryIds: config.entryIds ?? ['entry-1'],
      values: config.values ?? {},
      redacted: config.redacted ?? [],
    })),
    mcp: (input.mcp ?? []).map((server, index) => ({
      id: server.id ?? `mcp:${server.serverName ?? `server-${index}`}`,
      serverName: server.serverName ?? `server-${index}`,
      entryId: server.entryId ?? `mcp-${index}`,
      transport: server.transport ?? 'stdio',
      installMethod: server.installMethod ?? 'npx',
      packageName: server.packageName,
      packageVersion: server.packageVersion,
      command: server.command,
      args: server.args ?? [],
      cwd: server.cwd,
      url: server.url,
      headerNames: server.headerNames ?? [],
      envNames: server.envNames ?? [],
      config: server.config ?? {},
      enabled: server.enabled ?? true,
    })),
  }
}
