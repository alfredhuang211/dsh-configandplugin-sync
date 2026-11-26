# Publishing

This plugin is distributed twice: from Git (`github:alfredhuang211/dsh-configandplugin-sync#<commit>`)
and, from `0.2.0` on, from npm as `@alfredhuang211/dsh-configandplugin-sync`.

## Naming rule

**Every package published under this account uses the `@alfredhuang211` scope.**

```jsonc
// package.json
{
  "name": "@alfredhuang211/dsh-configandplugin-sync",
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
}
```

Why the scope is mandatory: unscoped names are first-come-first-served on npm, and two of this
account's plugins already collided. `dsh-webdav-sync` belongs to `GaoHu1997/dsh-webdav`
(v1.3.3) and `dsh-opencode-session` to `nobu121/dsh-opencode-session` (v0.1.1); neither is this
repo's package. Even where the unscoped name is still free today, a scope keeps it from
disappearing underneath a published version later.

## What the scope touches, and what it deliberately does not

`0.1.0` → `0.2.0` renamed the package. The rename is breaking for anyone installed from Git, so
the version moved with it.

| Place | Field | Value |
|---|---|---|
| `package.json` | `name`, `publishConfig` | scoped |
| `cordis.patch.yml` | row `name` | scoped — Node has to resolve it |
| `src/constants.ts` | `PACKAGE_NAME`, `LOCALE_NS` | scoped |
| `src/index.ts`, `client/src/index.tsx` | `export const name` | scoped |

Three identifiers stay on the unscoped short name **on purpose**, because each is a piece of
on-disk or on-wire state rather than a module identifier:

| Identifier | Value | Why it did not move |
|---|---|---|
| `APP_DIR_NAME` | `dsh-configandplugin-sync` | names `$DSH_HOME/dsh-configandplugin-sync/`; renaming it would orphan the existing passphrase file and `config.json` |
| `API_PREFIX` (`src/http/api-types.ts`) | `/api/dsh-configandplugin-sync` | a `/` in the path would add an `@scope/` segment to every route, and this is wire contract between the two halves |
| row `id` in `cordis.patch.yml` | `dsh-configandplugin-sync` | the key a user's profile patch overrides; renaming it would silently orphan every existing override |

The locale namespace does follow the package name, matching the shipped plugins that do the same
(`dsh-client-ui-theme` uses `settings.theme` instead; either is legal, since a namespace is an
opaque string).

Upgrading an existing install therefore means reinstalling the bundle and nothing else — the data
directory and any profile override carry over untouched.

## Pre-publish checklist

```bash
npm run verify        # typecheck + build + full test suite
npm pack --dry-run    # inspect the real file list, not the `files` array
```

- `lib/` **must** be committed and present in the published tarball: DSH installs plugins with
  pnpm, which blocks dependency build scripts, so a package without a built `lib/` cannot load.
  `prepack` rebuilds it, so a `npm publish` from a clean checkout is still correct.
- `assets/icon.png`, `locale/*.json`, `docs/`, and `cordis.patch.yml` must be in `files`.
- The `meta` block in `locale/{en,zh}.json` drives the Plugins-page card. Its `meta.detail`
  paths must exist in the tarball (`docs/DETAIL.md`, `docs/DETAIL.zh.md`) and stay inside it.
- No secret may be in the tarball: grep the packed file list, and check `README`, `docs/`,
  `tests/` for real credentials.
- The version in `package.json`, `CHANGELOG.md` and the Git tag must agree.

## Verify the artifact, not the publish message

A brand-new package name is not installable the moment `npm publish` returns. Before announcing
the release, confirm the registry agrees and a clean profile can actually take it:

```bash
npm view @alfredhuang211/dsh-configandplugin-sync dist-tags.latest dist.tarball
DSH_HOME=$(mktemp -d) dsh plugin --profile check add @alfredhuang211/dsh-configandplugin-sync
DSH_HOME=$DSH_HOME dsh --profile check --dump-config | grep '== @alfredhuang211/dsh-configandplugin-sync'
```

The `--dump-config` layer line is the signal that the bundle patch loaded; the install output
alone only proves pnpm finished.

## After publishing

An installed plugin's inventory record carries a registry spec instead of a Git one:

```
@alfredhuang211/dsh-configandplugin-sync@0.2.0
```

which is what other devices restore from. Keep `github:` installs working in parallel — the
collector prefers the spec that actually installed the plugin, so both remain valid.
