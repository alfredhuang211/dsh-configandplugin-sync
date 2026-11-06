# Architecture

This document explains how `dsh-configandplugin-sync` is put together, what each
module is allowed to know, and which invariants the tests protect.

## One read → one plan → one write

Every operation follows the same shape, whether it is triggered by the settings
page, an agent tool, or the automatic scheduler:

```
        ┌─────────────┐      ┌──────────────┐      ┌──────────────┐
 local  │  collector  │      │   sections   │      │   applier    │
 DSH ──▶│ (collect/*) │─────▶│  (3-way      │─────▶│ (engine/     │──▶ DSH
 home   └─────────────┘      │   merge +    │      │  apply.ts)   │    home
                             │   plan)      │      └──────────────┘
 store ─▶  repository  ─────▶└──────────────┘              ▲
        (engine/repo.ts)           │                       │
        backends/*                 ▼                       │
                             plan is previewable ──────────┘
                             (nothing is written before it)
```

1. **Read both sides.** The collector turns the live profile into a
   `ProfileSnapshot`; the repository reads the store documents through one
   `SyncBackend`.
2. **Merge.** `engine/sections.ts` compares local, remote and the local
   baseline item by item. The result is a `SyncPlan` with actions, conflicts and
   warnings — and nothing has changed yet.
3. **Execute.** Pull actions go through `engine/apply.ts` (plugin manager,
   config editor, credential seam). Push actions become store documents written
   by the repository. Destructive plans and unresolved conflicts refuse to run.

A preview and its execution are guaranteed to see the same plan because the
engine holds a mutex across the whole cycle and caches the store read for the
duration of a run.

## Module responsibilities

| Module | Owns | May not |
|---|---|---|
| `types.ts` | the domain model | contain logic |
| `dsh.ts` | structural Host service types | import `@deepseek-ai/*` |
| `core/` | errors, JSON, redaction, logging, atomic file I/O, minimal YAML emit, patch-block surgery | know about sections or backends |
| `collect/` | reading a profile: files, entries, providers, plugins, plugin configs, MCP, secrets | write anything, or let a secret value into a record |
| `backends/` | Git / WebDAV / S3 transport, CAS, history | know what a section means |
| `engine/` | merge rules, plan, apply, encryption, store layout, rollback snapshots, the engine API | talk to a backend directly except through `SyncBackend` |
| `http/` | one POST route per operation, secret blanking, envelopes | contain business logic |
| `tools/` | agent-facing wrappers over the engine | duplicate engine logic |
| `scheduler.ts` | startup/interval/change triggers, backoff | decide conflicts |
| `client/` | the Settings page | see a secret value |

## The merge rule that everything depends on

Synchronization must never silently destroy work. The baseline — "the value this
device last agreed with the store about" — is what makes that decidable:

- local changed only → push;
- remote changed only → pull;
- both changed → merge if the documents only disagree on different parts
  (different Loader entry ids, different `package.json` keys), otherwise a
  **conflict** the user resolves;
- no baseline at all → a whole-value pick would be a guess, so the same
  document-level merge is attempted and a real disagreement conflicts.

Two consequences worth knowing:

- **The baseline only advances for items both sides now agree on.** A remote
  value this device has not applied stays out of the baseline, so a later run
  cannot mistake "never had it" for "deleted it" and write a tombstone.
- **Deletions are attributed from the baseline.** An item missing locally *and*
  present in the baseline is a local deletion (tombstone, destructive, needs
  confirmation); missing locally with no baseline means "adopt it".

## Device-local fields are not compared

`PluginRecord.rows[].entryId`, `profile`, `platform`, `ProviderRecord.entryId`
and `PluginConfigRecord.entryIds` are assigned per device. They are kept in the
stored value for display, but `comparisonValue()` drops them from the hash and
from conflict detection — otherwise two correct devices would look permanently
different and conflict on every run.

## Store layout and revisions

```
manifest.json                      revision, devices, per-document digests
profiles/<p>/<section>.json        one document per section
devices/<deviceId>.json            last snapshot per device
snapshots/<p>/<deviceId>/<ts>.json rollback snapshots (newest 20 per device)
```

The manifest revision increases on every write and is the CAS token for object
stores. A backend reports its own revision (git HEAD, or a content digest for
object stores); when it no longer matches what the engine read, the write is
rejected as a `conflict`, the engine re-reads and re-merges its actions against
fresh state, and only then writes again. Git is treated the same way — a silent
"rebase and push" in the backend would overwrite another device's section
document without anyone learning about it.

## Secrets

`~/.dsh/.credentials.yaml` is read by `collect/secrets.ts` (a small,
dependency-free YAML reader) or through `ctx.credentials` when the seam is
mounted. The payload is serialized to JSON, encrypted with AES-256-GCM under a
scrypt-derived key (N=2^15, r=8, p=1), and only the envelope is stored. The
passphrase comes from an environment variable or a one-off input; it is never
persisted.

Restoring merges rather than replaces: `writeSecrets` keeps references and
records the payload does not mention, and `apply.writeEntryConfig` keeps local
config fields the synchronized record redacted away. A device with the wrong
passphrase cannot decrypt the envelope and therefore never overwrites it.

## HTTP surface

All routes are `POST` + JSON under `/api/dsh-configandplugin-sync`, registered
on the Host connection's authenticated channel. They share one envelope
(`{ok:true,value}` / `{ok:false,error}`) and one rule: the four storage
credentials are blanked in every response, and an empty value submitted back
means "keep the stored one". `confirmation-required` and `conflict-present`
carry the plan in `details` so the page can render the decision.

## Testing strategy

- **Pure core**: patch/YAML block surgery, redaction, version comparison.
- **Merge matrix**: every local/remote/baseline combination, including the two
  auto-merge cases and the tombstone rules.
- **Repository**: document layout, revision increments, concurrent-write retry
  through the `rebuild` callback.
- **Backends**: a real local git repository for git (including a two-work-tree
  race), in-process HTTP servers for WebDAV and for S3 with an independently
  recomputed SigV4 signature.
- **Two devices**: a fake DSH home for A and B sharing one in-memory backend —
  backup on A, restore on B, convergence on the second round, no plugin code in
  the store, no plaintext secret in the store.
- **Routes**: registered handlers, envelopes, secret blanking, and the
  empty-means-keep round trip.

## Extending

- A new section: add it to `SectionId`/`SECTION_IDS`, teach `collect/` to produce
  it and `apply/` to write it, then add its case in `comparisonValue`,
  `localItemsFor`, `pushAction` and `pullActions`.
- A new backend: implement `SyncBackend` (five members) and register it in
  `backends/index.ts`; the engine, the UI and the tools need no change.
