/**
 * Section semantics: how a snapshot turns into store items, how two sides are
 * compared, and how a conflict is merged.
 *
 * Everything that decides "is this changed?" or "is this a conflict?" lives
 * here so the plan builder, the applier and the UI all agree on one answer.
 * The comparison is a three-way merge against the local baseline: a change can
 * only be attributed to a device when the device's last agreed value is known,
 * which is why an unknown baseline makes both sides suspicious instead of
 * silently overwriting one.
 * @module engine/sections
 */
import type { AnyRemoteSection, ConfigFileRecord, DshSectionValue, JsonValue, McpServerRecord, PluginConfigRecord, PluginRecord, ProfileSnapshot, ProviderRecord, SecretsEnvelope, SectionId, SyncPlan, ConflictResolution } from '../types.js';
/** One synchronizable item as this device sees it. */
export interface LocalItem {
    id: string;
    name: string;
    value: JsonValue;
    hash: string;
}
/** One item as the store sees it. */
export interface RemoteItemView {
    id: string;
    name: string;
    value: JsonValue;
    hash: string;
    deleted: boolean;
    updatedAt: string;
    updatedBy: string;
}
/** Baseline view: the last value this device agreed with the store about. */
export interface BaselineItem {
    hash: string;
    value: JsonValue;
}
/** Coerce a record type into lossless JSON (all records in `types.ts` are JSON-shaped). */
export declare function toJson(value: unknown): JsonValue;
/**
 * Project a synchronized value onto the fields that must agree across devices.
 *
 * Some fields are device-local by nature — the Loader entry id a device
 * happened to assign, the OS, the profile — and comparing them would make two
 * correct devices look permanently different (and, with no baseline, produce a
 * conflict on every run). They are dropped from the comparison and the hash,
 * while the stored value keeps them so the UI can still show provenance.
 */
export declare function comparisonValue(section: SectionId, value: JsonValue): JsonValue;
/** Build the local item set of one section from a snapshot. */
export declare function localItemsFor(snapshot: ProfileSnapshot, section: SectionId): Map<string, LocalItem>;
/** Build the remote item set of one section. */
export declare function remoteItemsFor(document: AnyRemoteSection | undefined, section: SectionId): Map<string, RemoteItemView>;
/** Build the baseline item set of one section. */
export declare function baselineItemsFor(baseline: Record<string, {
    hash: string;
    value: JsonValue;
}> | undefined): Map<string, BaselineItem>;
/** The fields that differ between two JSON objects, dotted for readability. */
export declare function changedFields(left: JsonValue, right: JsonValue, prefix?: string, depth?: number): string[];
/** Merge outcome for one item. */
export interface ItemMerge {
    /** Which side wins, or `none` when nothing may be written. */
    take: 'local' | 'remote' | 'none';
    /** Merged value when both sides changed different parts of one document. */
    merged?: JsonValue;
    /** Set when the local side removed an item the baseline knew. */
    localDeleted?: boolean;
    /** Set when the remote side recorded a tombstone for an item the baseline knew. */
    remoteDeleted?: boolean;
    /** Set when the two sides cannot be reconciled automatically. */
    conflict: boolean;
    /** Fields that differ, for the conflict UI. */
    fields: string[];
}
/**
 * Three-way merge for one item.
 *
 * The rule is the standard one, with two deliberate choices:
 *
 *  - a **missing baseline** makes two different values a conflict instead of a
 *    coin flip, because this plugin cannot know which device is newer;
 *  - a **deletion** is only attributed to a side when the baseline proves the
 *    item used to be there, so a value this device never had is adopted rather
 *    than deleted.
 */
export declare function mergeItem(section: SectionId, local: LocalItem | undefined, remote: RemoteItemView | undefined, base: BaselineItem | undefined): ItemMerge;
/**
 * Merge two changes that touched different parts of the same document.
 *
 * Configuration files are the case that matters: two devices editing different
 * Loader entries in one patch file must merge, not conflict. Entry ids make
 * that decidable, and the raw block text keeps `!!js` expressions intact.
 */
export declare function tryAutoMerge(section: SectionId, local: JsonValue, remote: JsonValue, base: JsonValue): JsonValue | null;
/**
 * Merge two documents with no shared baseline.
 *
 * A missing baseline means every entry looks "new", so a merge is only safe
 * when the two sides do not disagree about the same thing. The synthetic base
 * is empty: two docs that both add the *same* entry id with different content
 * conflict, while disjoint additions merge. `package.json` gets an empty object
 * so dependency keys are compared individually.
 */
export declare function tryAutoMergeWithoutBase(section: SectionId, local: JsonValue, remote: JsonValue): JsonValue | null;
/** Narrow a stored value to a configuration file record. */
export declare function asConfigFile(value: JsonValue): ConfigFileRecord | null;
/** Compute the current hash for an item value. */
export declare function hashOf(value: JsonValue): string;
/** Inputs of {@link buildPlan}. */
export interface PlanInput {
    direction: 'push' | 'pull' | 'two-way';
    profile: string;
    snapshot: ProfileSnapshot;
    /** Remote sections of this profile, keyed by section. */
    remote: Map<SectionId, AnyRemoteSection>;
    /** Baseline for this profile, keyed by section then item id. */
    baseline: Record<string, Record<string, BaselineItem>>;
    /** Section switches from the configuration. */
    enabled: Record<SectionId, boolean>;
    /** Item ids excluded per section. */
    excluded: Record<SectionId, string[]>;
    /** A user's decisions about conflicts from a previous preview. */
    resolutions: ConflictResolution[];
    /** Secrets envelope to push, when the secrets scope may run. */
    secretsEnvelope?: SecretsEnvelope | null;
    now?: () => Date;
}
/** Build the plan: what a backup, restore or sync would do. */
export declare function buildPlan(input: PlanInput): SyncPlan;
/**
 * Detect a version change between two plugin records.
 * @returns `upgrade`, `downgrade`, or null when the versions are equal or unknown.
 */
export declare function versionDirection(remoteVersion: string | null, localVersion: string | null): 'upgrade' | 'downgrade' | null;
/** Count actions that touch one section. */
export declare function countSectionActions(plan: SyncPlan, section: SectionId): number;
/** Build the remote sections the engine must write, given a plan's push actions. */
export declare function sectionValuesFromSnapshot(snapshot: ProfileSnapshot, section: SectionId): Record<string, JsonValue>;
/** The dsh-config section value assembled from a snapshot. */
export declare function dshSectionValue(snapshot: ProfileSnapshot): DshSectionValue;
/** Narrow a remote section item value to a plugin config record. */
export declare function asPluginConfigRecord(value: JsonValue): PluginConfigRecord | null;
/** Narrow a remote section item value to a provider record. */
export declare function asProviderRecord(value: JsonValue): ProviderRecord | null;
/** Narrow a remote section item value to an MCP record. */
export declare function asMcpRecord(value: JsonValue): McpServerRecord | null;
/** Narrow a remote section item value to a plugin record. */
export declare function asPluginRecord(value: JsonValue): PluginRecord | null;
