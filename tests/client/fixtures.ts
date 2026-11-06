/**
 * Shared fixtures for the DOM-free client tests.
 *
 * Not a test file itself: `vitest.config.ts` only collects `*.test.ts`, and
 * `tsconfig.client.json` typechecks this module together with the tests.
 */

import type {
  ConflictInfo,
  PlanAction,
  SectionId,
  SyncConfigView,
  SyncPlan,
} from '../../src/types.js'

/** Every section id, so exclusion maps can be built completely. */
export const SECTION_IDS: readonly SectionId[] = [
  'dsh-config',
  'providers',
  'plugins',
  'plugin-configs',
  'secrets',
  'mcp',
]

/** An empty per-section exclusion map. */
export function emptyExcluded(): Record<SectionId, string[]> {
  return {
    'dsh-config': [],
    providers: [],
    plugins: [],
    'plugin-configs': [],
    secrets: [],
    mcp: [],
  }
}

/** A complete `SyncConfigView` with non-secret defaults. */
export function makeConfigView(patch: Partial<SyncConfigView> = {}): SyncConfigView {
  return {
    backendKind: 'git',
    git: {
      kind: 'git',
      repoUrl: 'https://example.com/store.git',
      branch: 'main',
      authMode: 'ssh',
      tokenEnvVar: 'GITHUB_TOKEN',
      username: '',
    },
    webdav: {
      kind: 'webdav',
      url: 'https://dav.example.com/dsh',
      username: 'alice',
      password: '',
      token: '',
    },
    s3: {
      kind: 's3',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'dsh-store',
      prefix: 'sync',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: '',
      sessionToken: '',
      forcePathStyle: true,
    },
    profiles: ['default', 'work'],
    scopes: {
      dshConfig: true,
      providers: true,
      plugins: true,
      pluginConfigs: true,
      secrets: false,
      mcp: true,
    },
    passphraseEnvVar: 'DSH_SYNC_PASSPHRASE',
    excluded: { ...emptyExcluded(), plugins: ['local:notes'] },
    autoSync: {
      enabled: false,
      mode: 'two-way',
      intervalMinutes: 0,
      startupDelayMs: 15_000,
      onStartup: true,
      onPluginChange: false,
      debounceMs: 5_000,
    },
    deviceName: 'laptop',
    passphraseAvailable: false,
    tokenAvailable: true,
    device: {
      id: 'device-1',
      name: 'laptop',
      platform: 'darwin',
      arch: 'arm64',
      dshVersion: '0.9.0',
      pluginVersion: '0.1.0',
    },
    activeProfile: 'default',
    availableProfiles: ['default', 'work'],
    dataDir: '/home/alice/.dsh/plugins/dsh-configandplugin-sync',
    ...patch,
  }
}

/** One plan action. */
export function makeAction(patch: Partial<PlanAction> = {}): PlanAction {
  return {
    kind: 'install-plugin',
    section: 'plugins',
    id: 'pkg-a',
    name: 'pkg-a',
    detail: 'install pkg-a',
    destructive: false,
    ...patch,
  }
}

/** One conflict. */
export function makeConflict(patch: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    section: 'plugins',
    id: 'pkg-a',
    name: 'pkg-a',
    reason: 'both-changed',
    fields: ['version'],
    ...patch,
  }
}

/** A complete `SyncPlan`. */
export function makePlan(patch: Partial<SyncPlan> = {}): SyncPlan {
  return {
    direction: 'two-way',
    profile: 'default',
    generatedAt: '2026-01-02T03:04:05.000Z',
    actions: [],
    conflicts: [],
    diffs: [],
    requiresConfirmation: false,
    warnings: [],
    localItemCount: 10,
    remoteItemCount: 8,
    ...patch,
  }
}
