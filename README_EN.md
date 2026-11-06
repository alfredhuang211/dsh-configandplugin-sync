# DSH Config & Plugin Sync

> A DeepSeek Harness (DSH) plugin that synchronizes your **DSH configuration, model providers, plugin inventory and configuration, secrets, and MCP servers** across devices through Git, WebDAV, or S3-compatible storage.
>
> 中文: [README.md](./README.md)

## Why

Moving to another machine, the painful part of rebuilding DSH is never reinstalling plugins — it is everything around them:

- the **model providers** you tuned (base URL, API dialect, model list, default model);
- the **pinned versions** of a dozen plugins and **their configuration**;
- the **API keys and credential records**;
- hand-written **MCP server** definitions (npx/uvx arguments, URLs, header names);
- the profile's whole **cordis patch**, including your comments and `!!js` expressions.

This plugin extracts exactly those declaration-shaped facts, encrypts/merges them, and synchronizes them. **Plugin code is never part of it.**

## What is synchronized

| Content | Synced | Notes |
|---|---|---|
| DSH base configuration | ✅ | `$DSH_HOME/cordis.patch.yml`, `profiles/<name>/cordis.patch.yml`, `cordis.yml`, `package.json`; merged per Loader entry id, preserving comments and `!!js` |
| Model providers | ✅ | `providers` extracted from LLM entries (displayName/api/baseURL/apiKeyEnv/models) plus the `agent-default-model` selection |
| Plugin inventory / version / source | ✅ | name, version, `npm/git/local-path/tarball/official`, reproducible install spec, enabled state; a `link:`-installed plugin that is really a clean checkout of a single-package GitHub repository is recorded as `github:owner/repo#<commit>` and becomes restorable on another device |
| Plugin configuration | ✅ | the primary entry's values; secret-looking keys are dropped before writing and reported as `redacted` |
| Secrets / keys / credential records | ✅ (needs passphrase) | encrypted before leaving the device, see [Secrets](#secrets-and-passphrases) |
| MCP servers | ✅ | serverName, transport, install method and package version, command/args/url, header/env **names**, remaining config |
| Plugin code / node_modules / tarballs | ❌ | only "what to install and how", never the code |
| Local-directory plugins (`link:` / `file:`) | ❌ not synced | only recorded in the device snapshot with `restorable: false`; neither their contents nor their code is copied, and they stay out of the synchronized inventory (otherwise every run would report a difference the other device can never satisfy) |
| Session history / logs / caches | ❌ | not configuration |

## Backends

| Backend | Good for | Auth | Concurrency |
|---|---|---|---|
| **Git** | version history, shared repos, reviewable changes | SSH / credential helper / HTTPS token from an env var | branch HEAD compare; pull-then-retry on non-fast-forward, never force-push |
| **WebDAV** | self-hosted NAS / Nextcloud-style servers | Basic or Bearer | ETag + `If-Match`, 412 is a conflict |
| **S3-compatible** | AWS S3 / MinIO / Cloudflare R2 | access key + secret (+ optional session token), local SigV4 | `If-Match`/ETag compare, conflict is rejected |

All three share one document layout, so a store can move between them without the plugin caring.

### Store layout

```
dsh-config-sync/                    # configurable root prefix
├── manifest.json                   # schema, revision, devices, per-document digests
├── profiles/<profile>/
│   ├── dsh-config.json             # config files (verbatim text) + parsed entries
│   ├── providers.json
│   ├── plugins.json
│   ├── plugin-configs.json
│   ├── mcp.json
│   └── secrets.json                # encrypted envelope only
├── devices/<deviceId>.json         # last snapshot per device
└── snapshots/<profile>/<deviceId>/<ts>.json   # rollback snapshots (newest 20 kept)
```

## Install

```bash
npm install
npm run build          # emits lib/ (host) and lib/client.js (browser half)
```

Then install the directory in DSH:

```
plugin_manager install_bundle  target: /absolute/path/dsh-configandplugin-sync
```

Restart DSH (or wait for HMR) and the Settings dialog shows **DSH 配置与插件同步 / DSH Config & Plugin Sync**.

> `lib/` is a build artifact but must be committed: DSH installs plugins with pnpm, which blocks dependency build scripts, so a Git install needs the built half in the repository.

## Quick start

1. **Settings → Config**: pick a backend (Git/WebDAV/S3) and fill in the address and credentials (credentials stay local, see [Security](#security)).
2. **Test connection** and confirm `ok: true` with a revision.
3. Choose the **scopes** to synchronize (config / providers / plugins / plugin configs / secrets / MCP) and save.
4. **Sync → Preview**: review uploads/downloads/conflicts, then confirm.
5. On the other device, repeat 1–3, then **Preview → Restore**.

On the first sync between two devices that both already hold a value, differing content becomes a **conflict** rather than a silent overwrite. That is deliberate.

## Secrets and passphrases

Secret synchronization is **off by default**. Before enabling it, give the plugin a passphrase — three ways, in order of preference:

### Option A: save it to the local passphrase file (recommended for the desktop app)

**Settings → DSH Config & Plugin Sync → Secrets → Local passphrase file → type it → Save locally.**

- written to `~/.dsh/dsh-configandplugin-sync/passphrase` with mode `0600`;
- **no environment variable, takes effect immediately, no restart**;
- stays on this device, is never synchronized, and never appears on any page or log line.

### Option B: launch environment

```bash
# macOS: launch with the variable for this run
open -a "DeepSeek Harness" --env DSH_SYNC_PASSPHRASE='your passphrase'

# or hand it to launchd (applies to apps launched afterwards)
launchctl setenv DSH_SYNC_PASSPHRASE 'your passphrase'
```

### Option C: rename it and use `~/.dsh/.env`

```bash
# DSH rejects any DSH_-prefixed variable from .env, so rename the configured
# variable first, e.g. to SYNC_PASSPHRASE, then in ~/.dsh/.env:
SYNC_PASSPHRASE='your passphrase'
```

A `.env` change needs a DSH restart (it is read once at startup).

> ⚠️ **Do not** put `DSH_SYNC_PASSPHRASE` in `~/.dsh/.env`: DSH refuses every `DSH_` / `XDG_` / `DYLD_` variable there (they decide how the process starts, what code loads, and how it reaches the network) and fails startup. That restriction is exactly why the local passphrase file exists.

Encryption: `scrypt(N=2^15, r=8, p=1)` → 32-byte key → `AES-256-GCM`. The envelope holds only salt / iv / tag / ciphertext — no passphrase, no plaintext — and the passphrase is never written to configuration or to the store.

## Plaintext secrets inside configuration files

Patch files are synchronized as their **literal text** (that is what lets a restore reproduce comments and `!!js` expressions), so a password hardcoded in `cordis.patch.yml` would otherwise be uploaded with the rest. It is not:

- when collecting, the value of every **secret-looking key** (`password`, `token`, `apiKey`, `Authorization`, `secret`, …) is replaced with `"***"`, and a warning names the file, line and key — never the value;
- the value therefore never reaches the store, the settings page, or an agent response;
- on restore, a local value for the same key at the same indentation is put back (`preserveMaskedValues`), so `***` never overwrites a real credential; when the device has none, the mask stays and the outcome says how many values need to be filled in.

The right fix is to keep such credentials in the credential store (`~/.dsh/.credentials.yaml`) and reference them from configuration (`apiKeyEnv: TFLOW_API_KEY`): those are synchronized **encrypted** (see [Secrets](#secrets-and-passphrases)) instead of masked.

## Conflict and merge rules

Synchronization is a three-way merge: local baseline (last agreed value) + local value + stored value.

| Local | Store | Baseline | Result |
|---|---|---|---|
| present (unchanged) | present (unchanged) | present | nothing |
| changed | unchanged | present | push |
| unchanged | changed | present | pull |
| changed | changed | present | **conflict**, user picks local/remote/skip |
| present | absent | absent | push (first contact) |
| absent | present | absent | pull (adopt) |
| absent | present | present | local deletion → tombstone (destructive, confirm) |
| present | tombstone | present | remote deletion → plugin removal (destructive, confirm) |

Two cases that look like conflicts but merge automatically:

- **patch files**: both devices edited **different entry ids** → merged by id, both keep their work; the same id is a real conflict;
- **`package.json`**: different dependencies/bundles merge; the same dependency with two different versions conflicts.

Deletion is always destructive and requires `confirmDestructive`. A remote tombstone only removes a plugin (through the plugin manager); other sections report it rather than half-applying it.

## Automatic sync

- **on startup** (15s delay by default);
- **periodically** (30 min by default; 0 disables);
- **after a plugin change** (off by default, 5s debounce).

An automatic run that meets a conflict **pauses and reports** instead of deciding for you; consecutive failures back off exponentially up to one hour.

## Agent tools

`dsh_sync_status`, `dsh_sync_inventory`, `dsh_sync_diff`, `dsh_sync_backup`, `dsh_sync_restore`, `dsh_sync_sync`, `dsh_sync_history`, `dsh_sync_secrets_status` — all backed by the same engine the settings page uses, and all two-phase (preview, then `confirm: true`).

## Security

- Secrets are **encrypted before leaving the device**; the store never holds a plaintext key.
- Storage credentials are **never sent to the browser**: `webdav.password`, `webdav.token`, `s3.secretAccessKey`, `s3.sessionToken` are blanked in every HTTP response, and submitting an empty value means "keep the stored one".
- **Log redaction**: `sk-…`, `ghp_…`, `xox…`, URL `user:pass@`, `Bearer …`, `password=…` are replaced before any sink.
- Only header/env **names** cross devices, never their values.
- The private config file is `0600` inside a `0700` directory.
- ⚠️ As everywhere in DSH, the agent runs as your OS user, so local credential files are readable by it. What this plugin guarantees is that secrets are not written to the synchronized store, not written to logs, and not returned to the browser.

## Development

```bash
npm run typecheck   # host + client tsconfigs
npm test            # vitest (offline, deterministic)
npm run build       # tsc (host) + esbuild (client)
npm run verify      # all of the above
```

## Known limitations

- Only the **active profile** can be synchronized (other profiles are handled by their own running instance).
- Local-directory plugins are not copied, so the target device needs them installed by other means; only the source is recorded.
- Rollback replays **the plugin's own snapshots**; Git additionally shows commit history, but rollback still uses snapshots.
- Official/built-in bundles are recorded, never reinstalled or removed.
- WebDAV/S3 have no native history; the History tab lists snapshots.

## License

[MIT](./LICENSE)
