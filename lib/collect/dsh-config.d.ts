/**
 * DSH configuration collection.
 *
 * A profile's configuration is captured as the *literal text* of the files the
 * Loader composes — the home patch, the profile patch, `cordis.yml` and the
 * profile `package.json` — plus the parsed, secret-free entries for the engine
 * to compare. The file text is the write path: a restore merges patch blocks
 * verbatim, so comments, ordering and `!!js` expressions survive a round trip
 * that re-serializing YAML would destroy.
 *
 * The parsed entries come from `ctx.configEditor` when the Host exposes it and
 * from {@link splitPatch} otherwise; the fallback recovers identity only, since
 * this plugin does not carry a YAML parser for patch files.
 *
 * Nothing here throws on a bad file: an unreadable or unparsable file becomes a
 * warning and the rest of the snapshot is still produced.
 * @module collect/dsh-config
 */
import type { DshConfigRecord, SyncLogger } from '../types.js';
/** Facts read out of the profile `package.json`. */
export interface ProfilePackageFacts {
    /** Dependency name → specifier. */
    dependencies: Record<string, string>;
    /** Bundle names selected by the profile, in declared order. */
    bundles: string[];
}
/** Options of {@link collectDshConfig}. */
export interface DshConfigReadOptions {
    /** Absolute DSH home (`$DSH_HOME` or `~/.dsh`). */
    dshHome: string;
    /** `<dshHome>/profiles`; defaults to `join(dshHome, 'profiles')`. */
    profilesRoot?: string;
    /** Profile name (`desktop`). */
    profile: string;
    /** `ctx.configEditor`, feature-detected by the caller. */
    configEditor?: unknown;
    /** Logger for non-fatal problems; never receives configuration values. */
    logger?: SyncLogger;
    /** Aborted when the caller cancels collection. */
    signal?: AbortSignal;
}
/** Everything one profile's configuration read produced. */
export interface DshConfigReadResult {
    /** The `dsh-config` section value. */
    record: DshConfigRecord;
    /** Absolute profile directory, or null when it cannot be resolved safely. */
    profileDir: string | null;
    /** Profile dependency map, also mirrored into `record.dependencies`. */
    dependencies: Record<string, string>;
    /** Bundle names, also mirrored into `record.bundles`. */
    bundles: string[];
    /** Where the parsed entries came from. */
    entriesSource: 'config-editor' | 'patch' | 'none';
}
/** Parse the text of a profile `package.json`; null when unusable. */
export declare function parseProfilePackage(text: string): ProfilePackageFacts | null;
/**
 * Read one profile's whole DSH configuration.
 *
 * The result always has a valid {@link DshConfigRecord}: unreadable files,
 * an unsafe profile name or a malformed `package.json` are reported through
 * `record.warnings` instead of failing the collection.
 */
export declare function collectDshConfig(options: DshConfigReadOptions): Promise<DshConfigReadResult>;
