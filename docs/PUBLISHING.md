# Publishing

This plugin is currently distributed through Git (`github:alfredhuang211/dsh-configandplugin-sync#<commit>`).
If it is ever published to npm, follow this document — the naming rule exists to avoid
colliding with community packages.

## Naming rule

**Every package published under this account uses the `@alfredhuang211` scope.**

```jsonc
// package.json
{
  "name": "@alfredhuang211/dsh-configandplugin-sync",
  "publishConfig": { "access": "public" }   // or omit for a private package
}
```

Why the scope is mandatory: unscoped names are first-come-first-served on npm, and at least one
already collides. `dsh-webdav-sync` on npm belongs to `GaoHu1997/dsh-webdav` (v1.3.2), which is a
different project from this account's `dsh-webdav-sync`. Publishing unscoped would either fail or
shadow the other project's name.

## What a rename touches

Renaming from `dsh-configandplugin-sync` to `@alfredhuang211/dsh-configandplugin-sync` is a
breaking change for anything that already installed it. Change all of these together:

| Place | Field |
|---|---|
| `package.json` | `name` (and add `publishConfig`) |
| `cordis.patch.yml` | the `insert:` row `id` and `name` |
| `src/constants.ts` | `PACKAGE_NAME` (drives the HTTP prefix, locale namespace, data directory) |
| `src/index.ts` / `client/src/index.tsx` | `export const name` |
| `client/src/index.tsx` | the slot `id` (`config-sync` may stay; the namespace follows `PACKAGE_NAME`) |
| Installed profiles | reinstall the bundle, then remove the old data directory `~/.dsh/dsh-configandplugin-sync` |

The HTTP API prefix and the locale namespace are derived from `PACKAGE_NAME`, so a rename changes
both — the browser half and the host half must be rebuilt and reloaded together.

## Pre-publish checklist

```bash
npm run verify        # typecheck + build + full test suite
node -e "console.log(require('./package.json').files)"   # lib/ must be included
```

- `lib/` **must** be committed and present in the published tarball: DSH installs plugins with
  pnpm, which blocks dependency build scripts, so a package without a built `lib/` cannot load.
- `assets/icon.png`, `locale/*.json` and `cordis.patch.yml` must be in `files`.
- No secret may be in the tarball: `npm pack --dry-run` then grep the file list, and check
  `README`, `docs/`, `tests/` for real credentials.
- The version in `package.json`, `CHANGELOG.md` and the Git tag must agree.

## After publishing

An installed plugin's inventory record then carries a registry spec instead of a Git one:

```
@alfredhuang211/dsh-configandplugin-sync@0.2.0
```

which is what other devices restore from. Keep publishing `github:` installs working in parallel —
the collector prefers the spec that actually installed the plugin, so both remain valid.
