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
export declare const SCHEMA_VERSION = 1;
/** Lossless JSON value; the only shape a synchronized document may contain. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** Lossless JSON object. */
export type JsonObject = {
    [key: string]: JsonValue;
};
/**
 * One independently switchable slice of the synchronized state.
 *
 * The split exists so a user can keep e.g. secrets off a shared storage while
 * still sharing the plugin inventory, and so the UI can report each slice
 * separately instead of one opaque blob.
 */
export type SectionId = 'dsh-config' | 'providers' | 'plugins' | 'plugin-configs' | 'secrets' | 'mcp';
/** Every section, in the order the settings page lists them. */
export declare const SECTION_IDS: readonly SectionId[];
/** Human-readable English labels, used by the headless half (logs, tools). */
export declare const SECTION_LABELS: Record<SectionId, string>;
/** Which sections this device synchronizes. Every flag defaults to true. */
export interface SectionScopes {
    /** DSH base configuration: home patch, profile patch, profile package.json, cordis.yml. */
    dshConfig: boolean;
    /** Model providers extracted from LLM entries, normalized for cross-device restore. */
    providers: boolean;
    /** Plugin inventory: name, version, install source, enabled state. No code. */
    plugins: boolean;
    /** Per-plugin configuration values, with secret-looking keys removed. */
    pluginConfigs: boolean;
    /**
     * Secrets and API keys, always encrypted before they leave the device.
     * Off by default: it needs an explicit passphrase.
     */
    secrets: boolean;
    /** MCP server definitions: transport, install method, version, configuration. */
    mcp: boolean;
}
/** Default scopes: everything except secrets, which need a passphrase first. */
export declare function defaultScopes(): SectionScopes;
/** Device identity recorded with every snapshot and every remote section. */
export interface DeviceInfo {
    /** Stable random identifier generated once per DSH home. */
    id: string;
    /** User-visible device name (defaults to the host name). */
    name: string;
    /** `process.platform` of the device. */
    platform: string;
    /** CPU architecture. */
    arch: string;
    /** DSH version running on the device. */
    dshVersion: string;
    /** Version of this plugin on the device. */
    pluginVersion: string;
}
/** Which file of the DSH configuration tree a record describes. */
export type ConfigFileKind = 'home-patch' | 'profile-patch' | 'profile-cordis' | 'profile-package';
/**
 * One configuration file as synchronized.
 *
 * `content` is the literal file text (YAML or JSON, UTF-8), not a re-serialized
 * document: this keeps comments, ordering and `!!js` expressions exactly as the
 * user wrote them, which a YAML round-trip would destroy.
 */
export interface ConfigFileRecord {
    /** Path relative to the DSH home, using `/`, e.g. `profiles/desktop/cordis.patch.yml`. */
    path: string;
    kind: ConfigFileKind;
    /** SHA-256 of the UTF-8 content, for cheap equality checks. */
    sha256: string;
    /** File size in bytes before lossy normalization (informational). */
    size: number;
    /** Literal UTF-8 file text. Never contains a resolved secret value. */
    content: string;
}
/**
 * One Loader entry as read from the active profile, with secrets removed.
 *
 * This is the *parsed* view: it is what the engine compares per-entry and what
 * the settings page renders. The raw file text in {@link DshConfigRecord.files}
 * remains the write path, so a restore never has to re-serialize YAML.
 */
export interface ConfigEntryRecord {
    /** Loader entry id (`id:` in the patch). */
    id: string;
    /** Module or package name (`name:`). */
    name?: string;
    /** Present when the entry is inserted by the profile patch rather than a bundle. */
    patchId?: string;
    /** Loader `disabled:` flag, when set. */
    disabled?: boolean;
    /** Non-secret configuration values of the entry. */
    config: JsonObject;
    /** Config paths that were dropped because they look like secrets. */
    redacted: string[];
}
/** The whole DSH configuration slice of one profile. */
export interface DshConfigRecord {
    profile: string;
    /** Files, home patch first. */
    files: ConfigFileRecord[];
    /** Parsed entries with secret-looking values removed. */
    entries: ConfigEntryRecord[];
    /** Bundle names selected by the profile (`dsh.profile.bundles`), in order. */
    bundles: string[];
    /** Profile dependency specifiers (`package.json` `dependencies`). */
    dependencies: Record<string, string>;
    /** Non-fatal problems met while reading (missing file, unparsable YAML). */
    warnings: string[];
}
/** One model provider declaration, normalized out of its hosting LLM entry. */
export interface ProviderRecord {
    /** Provider id as used by `agent-default-model` and model references. */
    id: string;
    /** Loader entry that declares it (for write-back). */
    entryId: string;
    /** Human-readable display name. */
    displayName?: string;
    /** API dialect (`openai-completions`, `openai-responses`, `anthropic-messages`, ...). */
    api?: string;
    /** Base URL, without credentials. */
    baseURL?: string;
    /** Environment variable naming the key; never the key itself. */
    apiKeyEnv?: string;
    /** Model ids offered by the provider. */
    models: string[];
    /** Other provider fields, kept as-is (timeouts, headers, reasoning options). */
    extra: JsonObject;
}
/** The profile's default model selection. */
export interface ModelSelectionRecord {
    provider?: string;
    model?: string;
    /** Entry id that declares it, when known. */
    entryId?: string;
}
/** Where an installed plugin came from. */
export type PluginOrigin = 'npm' | 'git' | 'local-path' | 'tarball' | 'official' | 'unknown';
/** One Loader row contributed by a bundle (a bundle may declare several). */
export interface PluginRowRecord {
    /** Loader entry identity on the scanning device. */
    entryId?: string;
    /** Patch row id declared by the bundle. */
    rowId?: string;
    moduleName: string;
    enabled: boolean;
}
/**
 * One plugin as scanned on a device, or as stored in the shared state.
 *
 * Deliberately metadata only: this plugin synchronizes *what is installed and
 * how to install it*, never the plugin's code, `node_modules`, or a tarball.
 * A `local-path` plugin therefore carries its source path and is marked
 * `restorable: false`, because copying the directory would be copying code.
 */
export interface PluginRecord {
    /** Cross-device identity: the package name, or `local:<name>` for a local plugin. */
    id: string;
    /** npm package name, or the directory name of a local plugin. */
    name: string;
    displayName?: string;
    /** Installed version, or null when unknown. */
    version: string | null;
    origin: PluginOrigin;
    /** Sanitized origin spec: a URL without credentials, a `link:` path, or a registry name. */
    source?: string;
    /** Reproducible install spec accepted by `pluginManager.installBundle`, when installable. */
    installSpec: string | null;
    /** How a human re-creates the install when no single spec exists. */
    installMethod?: McpInstallMethod;
    enabled: boolean;
    /** True for bundles shipped with DSH: listed, never reinstalled. */
    builtIn: boolean;
    /** Whether this plugin may be synchronized at all. */
    syncable: boolean;
    /** False when the plugin cannot be installed on another device (local path). */
    restorable: boolean;
    /** Profile this record was scanned in. */
    profile: string;
    /** `process.platform` the record was scanned on. */
    platform: string;
    rows: PluginRowRecord[];
    /** Set when the scanner could not fully inspect the plugin. */
    error?: string;
}
/** How a package is installed, for MCP servers and non-bundle tools. */
export type McpInstallMethod = 'npx' | 'uvx' | 'pip' | 'npm' | 'binary' | 'http' | 'docker' | 'unknown';
/** One plugin's synchronized configuration values. */
export interface PluginConfigRecord {
    /** Plugin id this configuration belongs to. */
    pluginId: string;
    /** Module name whose entries carry the values. */
    moduleName: string;
    /** Loader entries the values were read from; `entryIds[0]` is the primary entry. */
    entryIds: string[];
    /**
     * The primary entry's configuration object, with secret-looking paths
     * already removed. Applying it writes exactly this object onto `entryIds[0]`,
     * which is what makes a restore replace rather than merge a stale value.
     */
    values: JsonObject;
    /** Config paths omitted because they look like secrets. */
    redacted: string[];
}
/** One named secret reference (`DEEPSEEK_API_KEY` → value). */
export interface SecretRefRecord {
    /** The reference name; also the environment variable a config points at. */
    ref: string;
    /** Where the value came from on the device that recorded it. */
    source: 'store' | 'environment' | 'unknown';
}
/** One durable credential record (authorization grant or provider record). */
export interface SecretRecordEntry {
    key: string;
    kind: 'api-key' | 'grant';
    /** Record payload; encrypted with everything else. Never stored in the clear. */
    payload: JsonValue;
}
/**
 * The secret slice, before encryption.
 *
 * This structure only ever exists in memory and inside the encrypted envelope:
 * {@link SecretsSection.envelope} is what reaches a backend.
 */
export interface SecretsPayload {
    refs: SecretRefRecord[];
    /** Reference name → secret value. */
    values: Record<string, string>;
    records: SecretRecordEntry[];
}
/** Encrypted secret document as stored in a backend. */
export interface SecretsEnvelope {
    /** Envelope format version. */
    v: number;
    /** Key derivation used to turn the passphrase into an AES key. */
    kdf: {
        name: 'scrypt';
        N: number;
        r: number;
        p: number;
        salt: string;
    };
    /** Cipher used for the payload. */
    cipher: {
        name: 'aes-256-gcm';
        iv: string;
        tag: string;
    };
    /** AES-256-GCM ciphertext of the UTF-8 JSON payload, base64. */
    data: string;
    /** When the envelope was produced. */
    createdAt: string;
    /** Device that produced it. */
    deviceId: string;
    /** Number of references inside (for status display without decrypting). */
    refCount: number;
}
/** Result of reading the secret slice from a backend. */
export interface SecretsSection {
    /** Null when no encrypted document exists yet. */
    envelope: SecretsEnvelope | null;
}
/** One MCP server definition as synchronized. */
export interface McpServerRecord {
    /** Stable identity: `mcp:<serverName>`. */
    id: string;
    /** Namespace for the server's tool names. */
    serverName: string;
    /** Loader entry that declares it (one entry per server). */
    entryId: string;
    /** Transport the client uses. */
    transport: 'stdio' | 'streamable-http' | 'sse' | 'unknown';
    /** How the server program itself is obtained and started. */
    installMethod: McpInstallMethod;
    /** Package or image the method names (`@modelcontextprotocol/server-github`). */
    packageName?: string;
    /** Pinned version of the package/image, when the spec carries one. */
    packageVersion?: string;
    /** Executable for stdio transports. */
    command?: string;
    /** Arguments, with secret-looking values redacted. */
    args: string[];
    /** Working directory, when set. */
    cwd?: string;
    /** Endpoint URL for HTTP transports. */
    url?: string;
    /** Header *names* only: values are secret material and never synchronized here. */
    headerNames: string[];
    /** Env *names* only, for the same reason. */
    envNames: string[];
    /** Remaining non-secret configuration (timeouts, reconnection policy). */
    config: JsonObject;
    /** Loader enabled state. */
    enabled: boolean;
}
/** Everything one device reports about one profile. */
export interface ProfileSnapshot {
    schemaVersion: number;
    profile: string;
    device: DeviceInfo;
    generatedAt: string;
    dsh: DshConfigRecord;
    providers: ProviderRecord[];
    defaultModel: ModelSelectionRecord | null;
    plugins: PluginRecord[];
    pluginConfigs: PluginConfigRecord[];
    mcp: McpServerRecord[];
}
/** Provenance stamped on every remote item. */
export interface Provenance {
    updatedAt: string;
    updatedBy: string;
}
/**
 * One item in a remote section.
 *
 * `deleted` is a tombstone: it records that a device deliberately removed the
 * item, so another device offers the removal instead of resurrecting it.
 */
export interface RemoteItem<T> extends Provenance {
    value: T;
    deleted?: boolean;
}
/** One remote section document (`profiles/<profile>/<section>.json`). */
export interface RemoteSection<T> {
    schemaVersion: number;
    profile: string;
    section: SectionId;
    /** Monotonic revision of this document, incremented on every write. */
    revision: number;
    updatedAt: string;
    /** Items keyed by their stable id. */
    items: Record<string, RemoteItem<T>>;
}
/** The union the engine works with, before per-section typing. */
export type AnyRemoteSection = RemoteSection<DshSectionValue> | RemoteSection<ProviderRecord> | RemoteSection<PluginRecord> | RemoteSection<PluginConfigRecord> | RemoteSection<McpServerRecord> | RemoteSection<SecretsEnvelope>;
/** Value of the `dsh-config` section: the whole configuration tree for a profile. */
export interface DshSectionValue {
    files: ConfigFileRecord[];
    entries: ConfigEntryRecord[];
    bundles: string[];
    dependencies: Record<string, string>;
}
/** Root `manifest.json` of a synchronized store. */
export interface StoreManifest {
    schemaVersion: number;
    generator: {
        name: string;
        version: string;
    };
    createdAt: string;
    updatedAt: string;
    /** Monotonic store revision; every write increments it. */
    revision: number;
    /** Device ids that have pushed a snapshot. */
    devices: string[];
    /** Per-profile summary for a fast status read. */
    profiles: Record<string, ProfileSummary>;
    /** SHA-256 of each stored document, so a cheap equality check needs no parse. */
    digests: Record<string, string>;
}
/** Fast summary of one profile in the manifest. */
export interface ProfileSummary extends Provenance {
    sections: Partial<Record<SectionId, {
        revision: number;
        count: number;
    }>>;
}
/** `devices/<deviceId>.json`: the last snapshot a device pushed. */
export interface DeviceSnapshotDocument {
    schemaVersion: number;
    device: DeviceInfo;
    profiles: Record<string, ProfileSnapshot>;
    updatedAt: string;
}
/** Storage backend kind. */
export type BackendKind = 'git' | 'webdav' | 's3';
/** Git authentication strategy. */
export type GitAuthMode = 'credential-helper' | 'ssh' | 'https-token';
/** Git backend configuration. */
export interface GitBackendConfig {
    kind: 'git';
    /** Repository URL: https, ssh, scp-like, or `file://`. */
    repoUrl: string;
    branch: string;
    authMode: GitAuthMode;
    /** Name of the environment variable holding an HTTPS token; never the token. */
    tokenEnvVar: string;
    /** HTTPS username paired with the token (defaults per provider). */
    username: string;
}
/** WebDAV backend configuration. */
export interface WebdavBackendConfig {
    kind: 'webdav';
    /** Collection URL, e.g. `https://dav.example.com/dav/dsh`. */
    url: string;
    username: string;
    /** Password, read from the local private config; never synchronized. */
    password: string;
    /** Optional bearer token instead of basic auth. */
    token: string;
}
/** S3-compatible backend configuration. */
export interface S3BackendConfig {
    kind: 's3';
    /** Endpoint URL, e.g. `https://s3.amazonaws.com` or `http://minio:9000`. */
    endpoint: string;
    region: string;
    bucket: string;
    /** Key prefix inside the bucket. */
    prefix: string;
    accessKeyId: string;
    /** Secret access key, read from the local private config; never synchronized. */
    secretAccessKey: string;
    /** Optional session token for temporary credentials. */
    sessionToken: string;
    /** Force path-style addressing (required by most self-hosted gateways). */
    forcePathStyle: boolean;
}
/** One storage backend configuration. */
export type BackendConfig = GitBackendConfig | WebdavBackendConfig | S3BackendConfig;
/** Which operation an automatic run performs. */
export type AutoSyncMode = 'two-way' | 'backup' | 'restore';
/** How the automatic synchronizer behaves. */
export interface AutoSyncConfig {
    enabled: boolean;
    mode: AutoSyncMode;
    /** Periodic interval in minutes; 0 disables the timer. */
    intervalMinutes: number;
    /** Delay before the startup sync, in milliseconds. */
    startupDelayMs: number;
    /** Run one sync after DSH starts. */
    onStartup: boolean;
    /** Queue a sync after DSH reports a plugin change (debounced). */
    onPluginChange: boolean;
    /** Debounce window for change-triggered syncs, in milliseconds. */
    debounceMs: number;
}
/** Local, non-secret configuration of this plugin. */
export interface SyncConfig {
    /** Which backend is active. Exactly one is used per run. */
    backendKind: BackendKind;
    /** Backend configurations; only the selected one is used. */
    git: GitBackendConfig;
    webdav: WebdavBackendConfig;
    s3: S3BackendConfig;
    /** DSH profiles to include. The active profile is always included. */
    profiles: string[];
    /** Section switches. */
    scopes: SectionScopes;
    /**
     * Passphrase used to encrypt the secret slice. Only an environment variable
     * name is stored here; the value itself never enters the configuration file.
     */
    passphraseEnvVar: string;
    /** Item ids never synchronized, per section. */
    excluded: Record<SectionId, string[]>;
    autoSync: AutoSyncConfig;
    /** Device name shown in history and status. */
    deviceName: string;
}
/** Configuration as shown to the UI: secrets never leave the host. */
export interface SyncConfigView extends SyncConfig {
    /** Whether a passphrase is available (environment variable or local file). */
    passphraseAvailable: boolean;
    /** Where the passphrase came from; null when none is available. */
    passphraseSource?: 'env' | 'file' | 'explicit' | null;
    /** Whether the configured token environment variable is present. */
    tokenAvailable: boolean;
    /** Effective device identity. */
    device: DeviceInfo;
    /** Profile this process is running in. */
    activeProfile: string;
    /** Profiles present in this DSH home. */
    availableProfiles: string[];
    /** Where this plugin keeps its data (display form). */
    dataDir: string;
}
/** How one item differs between the two sides. */
export type DiffKind = 'identical' | 'local-only' | 'remote-only' | 'changed' | 'deleted-remote' | 'deleted-local' | 'unsupported';
/** One difference, at item level. */
export interface ItemDiff {
    section: SectionId;
    id: string;
    name: string;
    kind: DiffKind;
    /** Field names that differ, e.g. `version`, `enabled`, `config.timeout`. */
    fields: string[];
    /** Whether resolving this difference removes something. */
    destructive: boolean;
    /** Set when the difference cannot be resolved automatically. */
    conflict?: ConflictInfo;
}
/** Everything a caller needs to decide about one conflict. */
export interface ConflictInfo {
    section: SectionId;
    id: string;
    name: string;
    /** Human-readable reason. */
    reason: string;
    fields: string[];
    local?: JsonValue;
    remote?: JsonValue;
    base?: JsonValue;
    /** Device that produced the remote change, when known. */
    remoteDevice?: string;
    remoteUpdatedAt?: string;
}
/** A user's decision for one conflict. */
export type ConflictChoice = 'local' | 'remote' | 'skip';
/** Resolution payload for one conflict. */
export interface ConflictResolution {
    section: SectionId;
    id: string;
    choice: ConflictChoice;
}
/** One executable step a plan produced. */
export type PlanActionKind = 'install-plugin' | 'upgrade-plugin' | 'downgrade-plugin' | 'enable-plugin' | 'disable-plugin' | 'remove-plugin' | 'write-plugin-config' | 'write-provider' | 'write-dsh-config' | 'write-mcp' | 'write-secret' | 'push-plugin' | 'push-plugin-config' | 'push-provider' | 'push-dsh-config' | 'push-mcp' | 'push-secret' | 'remove-remote-item';
/** One executable step. */
export interface PlanAction {
    kind: PlanActionKind;
    section: SectionId;
    /** Item identity inside its section. */
    id: string;
    /** Human-readable item name. */
    name: string;
    /** Detail for the UI. */
    detail: string;
    /** Removing something is destructive. */
    destructive: boolean;
    /** Install spec for install/upgrade/downgrade. */
    installSpec?: string;
    version?: string;
    enabled?: boolean;
    /** Configuration values to write, for config actions. */
    values?: JsonObject;
    /**
     * The value to write, carried by `pull` actions so the applier never has to
     * re-read the store (and so a preview and its execution stay consistent).
     */
    value?: JsonValue;
    /** Current value used for the diff (for logs and previews). */
    from?: string;
}
/** A complete plan: what a backup / restore / sync would do. */
export interface SyncPlan {
    direction: 'push' | 'pull' | 'two-way';
    profile: string;
    generatedAt: string;
    actions: PlanAction[];
    /** Differences that require a user decision. */
    conflicts: ConflictInfo[];
    /** Differences found but not actionable in this direction. */
    diffs: ItemDiff[];
    /** Destructive actions are present and require explicit confirmation. */
    requiresConfirmation: boolean;
    /** Human-readable warnings (skipped local plugin, missing passphrase, ...). */
    warnings: string[];
    localItemCount: number;
    remoteItemCount: number;
}
/** Per-action execution outcome. */
export interface ActionOutcome {
    action: PlanAction;
    ok: boolean;
    skipped?: boolean;
    detail?: string;
    error?: string;
}
/** What an operation produced. */
export interface OperationResult {
    ok: boolean;
    operation: 'backup' | 'restore' | 'sync' | 'rollback';
    startedAt: string;
    finishedAt: string;
    /** Store revision after the operation, when the backend reports one. */
    revision: string | null;
    pushed: boolean;
    noChanges: boolean;
    actionOutcomes: ActionOutcome[];
    warnings: string[];
    error?: string;
    /** Set when the operation needs a DSH restart to take effect. */
    restartRequired?: boolean;
}
/** High-level synchronization state shown by the settings page. */
export type SyncState = 'not-configured' | 'synced' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'error' | 'syncing' | 'unknown';
/** Last operation, for the status panel. */
export interface LastOperation {
    operation: 'backup' | 'restore' | 'sync' | 'rollback';
    at: string;
    ok: boolean;
    error?: string;
    revision?: string | null;
    changedItems?: number;
}
/** Everything the settings page needs for its status area. */
export interface StatusView {
    state: SyncState;
    config: SyncConfigView;
    branch: string;
    lastSyncAt: string | null;
    lastRevision: string | null;
    lastOperation: LastOperation | null;
    localItemCount: number;
    remoteItemCount: number | null;
    pendingUploads: number;
    pendingDownloads: number;
    conflictCount: number;
    lastError: string | null;
    /** Non-fatal findings from the last scan (masked secret, unreadable file, ...). */
    warnings: string[];
    autoSyncFailures: number;
    busy: boolean;
    connection: ConnectionTestResult | null;
    /** Per-section counts and digests, for the section cards. */
    sections: SectionStatus[];
}
/** Per-section health shown as one card. */
export interface SectionStatus {
    section: SectionId;
    enabled: boolean;
    localCount: number;
    remoteCount: number | null;
    changedCount: number;
    conflictCount: number;
    lastUpdatedAt: string | null;
    /** Set when the section is enabled but cannot run, e.g. secrets without a passphrase. */
    blocked?: string;
}
/** Outcome of a storage connectivity test. */
export interface ConnectionTestResult {
    ok: boolean;
    at: string;
    kind: BackendKind;
    /** Store revision observed, when the backend could read it. */
    revision: string | null;
    message: string;
    /** How authentication resolved (never includes the secret). */
    authMethod?: string;
}
/** One commit (git) or one recorded write (other backends) of the store. */
export interface HistoryEntry {
    commit: string;
    shortCommit: string;
    date: string;
    author: string;
    subject: string;
    /** Operation recorded by this plugin (`backup` / `restore` / `sync` / ...). */
    operation: string;
    deviceId?: string;
    deviceName?: string;
    profile?: string;
    itemCount?: number;
    result?: string;
}
/** Metadata trailers this plugin writes into every git commit. */
export interface CommitTrailers {
    operation: string;
    deviceId: string;
    deviceName: string;
    profile: string;
    result: string;
    itemCount: string;
    [key: string]: string;
}
/** Baseline entry: what this device last agreed with the store about one item. */
export interface BaselineEntry {
    /** Stable fingerprint of the synchronized value. */
    hash: string;
    /** The value itself, so a three-way merge needs no second read. */
    value: JsonValue;
}
/** Local baseline for one profile: "what this device last agreed with the store about". */
export interface SyncBaseline {
    profile: string;
    /** Store revision the baseline was taken at. */
    revision: string | null;
    updatedAt: string;
    /** Section id → item id → baseline. */
    sections: Record<string, Record<string, BaselineEntry>>;
}
/** Unresolved conflicts from the last run. */
export interface PendingConflict {
    section: SectionId;
    conflict: ConflictInfo;
    detectedAt: string;
}
/** Local, persisted runtime state (not the configuration). */
export interface LocalState {
    schemaVersion: number;
    device: DeviceInfo;
    lastSyncAt: string | null;
    lastRevision: string | null;
    lastOperation: LastOperation | null;
    lastError: string | null;
    baselines: Record<string, SyncBaseline>;
    conflicts: PendingConflict[];
    connection: ConnectionTestResult | null;
    /** Consecutive failed automatic runs, for backoff. */
    autoSyncFailures: number;
}
/** One log record. */
export interface LogEntry {
    at: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    details?: JsonValue;
}
/** Logger used by every module; implementations must redact secrets. */
export interface SyncLogger {
    debug(message: string, details?: JsonValue): void;
    info(message: string, details?: JsonValue): void;
    warn(message: string, details?: JsonValue): void;
    error(message: string, details?: JsonValue): void;
    /** Recent entries for the settings page. */
    recent(limit?: number): LogEntry[];
}
/** Revision of a store, plus every document in it, relative to the store root. */
export interface StoreSnapshot {
    /** Opaque revision: a git commit, or a hash of the document set for object stores. */
    revision: string | null;
    /** Store-relative path (`profiles/desktop/plugins.json`) → bytes. */
    files: Map<string, Uint8Array>;
}
/** Everything one write changes. */
export interface StoreWriteRequest {
    /** Path → content to create or replace. */
    files: Map<string, Uint8Array>;
    /** Paths to delete (a missing path is a no-op). */
    deletions: string[];
    /** Commit subject for git, or a human note for object stores. */
    message: string;
    /** Trailers recorded with the write. */
    trailers: CommitTrailers;
    /**
     * Revision the caller read before deciding what to write. A backend that can
     * detect a concurrent writer rejects the write instead of clobbering it.
     */
    expectedRevision: string | null;
    signal?: AbortSignal;
}
/** Outcome of one write. */
export interface StoreWriteResult {
    changed: boolean;
    revision: string | null;
    changedFiles: string[];
    /** Set when the write raced another device and was retried against fresh state. */
    retried: boolean;
}
/**
 * One storage backend.
 *
 * The engine only ever sees this interface: everything specific to git, WebDAV
 * or S3 lives behind it, which is what makes the three interchangeable and the
 * engine testable with an in-memory implementation.
 */
export interface SyncBackend {
    readonly kind: BackendKind;
    /** Human-readable destination, safe to display (no credentials). */
    readonly destination: string;
    /** Read every document plus the current revision. */
    read(signal?: AbortSignal): Promise<StoreSnapshot>;
    /** Write the given documents as one atomic change. */
    write(request: StoreWriteRequest): Promise<StoreWriteResult>;
    /** Recent history, when the backend has it (git does; object stores do not). */
    history(options?: {
        limit?: number;
        signal?: AbortSignal;
    }): Promise<HistoryEntry[]>;
    /** Check reachability and authentication without changing anything. */
    testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
}
/** Services the collectors may read; every one is feature-detected. */
export interface CollectorServices {
    pluginManager?: unknown;
    configEditor?: unknown;
    settings?: unknown;
    credentials?: unknown;
    profileContext?: unknown;
}
/** Everything a collector needs to read one profile. */
export interface CollectorContext {
    dshHome: string;
    profilesRoot: string;
    profile: string;
    services: CollectorServices;
    logger: SyncLogger;
    /** Plugin version, stamped into records. */
    pluginVersion: string;
    /** DSH version, stamped into records. */
    dshVersion: string;
    signal?: AbortSignal;
}
/** Builds the per-profile snapshot the engine compares. */
export interface SnapshotCollector {
    collect(context: CollectorContext, scopes: SectionScopes): Promise<ProfileSnapshot>;
}
/** Applies a plan action to the local device. */
export interface LocalApplier {
    apply(action: PlanAction, context: CollectorContext): Promise<ActionOutcome>;
    /** Install spec a plugin record wants applied, or null when it is not installable. */
    installSpecFor(pluginId: string): string | null;
}
