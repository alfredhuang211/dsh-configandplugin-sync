/**
 * The synchronized store: one document per profile section, plus a manifest.
 *
 * This module owns the on-disk layout and nothing else. It never looks at what
 * a section *means*: it reads documents, hands the engine parsed sections, and
 * writes back whatever the engine decided, with a monotonic revision and
 * per-document digests so a status read can tell "changed" from "identical"
 * without parsing everything.
 *
 * Writes are compare-and-set: a backend that notices another device pushed
 * between the read and the write rejects it, and the optional `rebuild`
 * callback lets the engine merge again against the fresh state instead of
 * clobbering it.
 * @module engine/repository
 */
import { SECTION_IDS, SCHEMA_VERSION } from '../types.js';
import { SyncError, errorMessage } from '../core/errors.js';
import { sha256Bytes, sha256Text } from '../core/hash.js';
import { parseJson } from '../core/json.js';
import { normalizeStorePath } from '../core/paths.js';
/** File names inside the store. */
export const STORE_FILES = {
    manifest: 'manifest.json',
    devicePrefix: 'devices/',
    profilePrefix: 'profiles/',
};
/** Create a repository over one backend. */
export function createRepository(options) {
    const now = options.now ?? (() => new Date());
    const logger = options.logger;
    const read = async (signal) => {
        let snapshot;
        try {
            snapshot = await options.backend.read(signal);
        }
        catch (error) {
            throw new SyncError('network', `无法读取同步存储 / cannot read the store: ${errorMessage(error)}`);
        }
        return parseContents(snapshot, logger);
    };
    const write = async (change) => {
        const initial = await read(change.signal);
        let pending = change;
        let contents = initial;
        let retried = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const plan = buildWritePlan({
                contents,
                change: pending,
                generator: options.generator,
                now,
                logger,
            });
            if (plan.request.files.size === 0) {
                return { changed: false, revision: plan.manifest.revision === 0 ? contents.revision : String(plan.manifest.revision), changedFiles: [], retried };
            }
            if (pending.dryRun === true) {
                return {
                    changed: plan.changedFiles.length > 0,
                    revision: String(plan.manifest.revision),
                    changedFiles: plan.changedFiles,
                    retried,
                };
            }
            try {
                const result = await options.backend.write(plan.request);
                return { ...result, retried };
            }
            catch (error) {
                const syncError = toConflict(error);
                if (syncError === null || attempt === 1)
                    throw error;
                retried = true;
                logger.warn('检测到并发写入，重新读取并合并 / concurrent write detected, re-reading and merging');
                contents = await read(change.signal);
                const rebuilt = pending.rebuild === undefined ? null : await pending.rebuild(contents);
                if (rebuilt === null) {
                    throw new SyncError('conflict', '另一个设备同时修改了存储，请重试 / another device wrote concurrently, retry');
                }
                pending = rebuilt;
            }
        }
        throw new SyncError('conflict', '同步写入持续冲突，请重试 / the store kept conflicting, retry later');
    };
    return { read, write };
}
/** Parse a raw backend snapshot into typed documents. */
export function parseContents(snapshot, logger) {
    const files = new Map();
    for (const [path, data] of snapshot.files) {
        try {
            files.set(normalizeStorePath(path), data);
        }
        catch {
            logger.warn('忽略非法存储路径 / ignoring an invalid store path', { path });
        }
    }
    const manifestBytes = files.get(STORE_FILES.manifest);
    const manifest = manifestBytes === undefined ? null : readManifest(manifestBytes, logger);
    const profiles = new Map();
    for (const [path, data] of files) {
        if (!path.startsWith(STORE_FILES.profilePrefix))
            continue;
        const rest = path.slice(STORE_FILES.profilePrefix.length);
        const slash = rest.indexOf('/');
        if (slash <= 0)
            continue;
        const profile = rest.slice(0, slash);
        const file = rest.slice(slash + 1);
        if (!file.endsWith('.json'))
            continue;
        const section = file.slice(0, -'.json'.length);
        if (!SECTION_IDS.includes(section))
            continue;
        const parsed = parseJson(decode(data));
        if (parsed === null || typeof parsed !== 'object' || parsed.section !== section) {
            logger.warn('忽略无法解析的同步文档 / ignoring an unreadable section document', { path });
            continue;
        }
        const bucket = profiles.get(profile) ?? new Map();
        bucket.set(section, parsed);
        profiles.set(profile, bucket);
    }
    const devices = new Map();
    for (const [path, data] of files) {
        if (!path.startsWith(STORE_FILES.devicePrefix))
            continue;
        if (!path.endsWith('.json'))
            continue;
        const id = path.slice(STORE_FILES.devicePrefix.length, -'.json'.length);
        if (id === '' || id.includes('/'))
            continue;
        const parsed = parseJson(decode(data));
        if (parsed === null || typeof parsed !== 'object')
            continue;
        devices.set(id, parsed);
    }
    return { revision: snapshot.revision, files, manifest, profiles, devices };
}
/** Build the set of documents one change produces, including a new manifest. */
function buildWritePlan(input) {
    const { contents, change } = input;
    const timestamp = input.now().toISOString();
    const files = new Map(contents.files);
    const changedFiles = [];
    const sections = new Map(contents.profiles.get(change.profile) ?? []);
    for (const section of SECTION_IDS) {
        const next = change.sections[section];
        if (next === undefined)
            continue;
        const existing = sections.get(section);
        const revision = Math.max(existing?.revision ?? 0, 0) + 1;
        const document = { ...next, section, revision, updatedAt: timestamp };
        sections.set(section, document);
        const path = sectionPath(change.profile, section);
        const bytes = encodeJson(document);
        files.set(path, bytes);
        changedFiles.push(path);
    }
    if (change.device !== undefined) {
        const path = `${STORE_FILES.devicePrefix}${sanitizeDeviceId(change.device.device.id)}.json`;
        files.set(path, encodeJson(change.device));
        changedFiles.push(path);
    }
    if (change.extraFiles !== undefined) {
        for (const [path, bytes] of change.extraFiles) {
            const normalized = normalizeStorePath(path);
            files.set(normalized, bytes);
            changedFiles.push(normalized);
        }
    }
    for (const path of change.extraDeletions ?? []) {
        const normalized = normalizeStorePath(path);
        files.delete(normalized);
    }
    // Recompute the manifest from the documents that now exist.
    const deviceIds = new Set(contents.devices.keys());
    if (change.device !== undefined)
        deviceIds.add(change.device.device.id);
    const profiles = new Map(contents.profiles);
    profiles.set(change.profile, sections);
    const summaries = {};
    const digests = {};
    for (const [profile, bucket] of profiles) {
        const sectionSummaries = {};
        let updatedAt = timestamp;
        let updatedBy = change.trailers.deviceName ?? 'unknown';
        for (const section of SECTION_IDS) {
            const document = bucket.get(section);
            if (document === undefined)
                continue;
            sectionSummaries[section] = {
                revision: document.revision,
                count: Object.keys(document.items).length,
            };
            if (document.updatedAt > updatedAt) {
                updatedAt = document.updatedAt;
                updatedBy = change.trailers.deviceName ?? updatedBy;
            }
            const path = sectionPath(profile, section);
            const bytes = files.get(path);
            if (bytes !== undefined)
                digests[path] = sha256Bytes(bytes);
        }
        summaries[profile] = { sections: sectionSummaries, updatedAt, updatedBy };
    }
    const previous = contents.manifest;
    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        generator: input.generator,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        revision: (previous?.revision ?? 0) + 1,
        devices: [...deviceIds].sort(),
        profiles: summaries,
        digests,
    };
    const manifestBytes = encodeJson(manifest);
    files.set(STORE_FILES.manifest, manifestBytes);
    if (!changedFiles.includes(STORE_FILES.manifest))
        changedFiles.push(STORE_FILES.manifest);
    const deletions = [...contents.files.keys()].filter(path => !files.has(path));
    for (const path of deletions)
        files.delete(path);
    return {
        manifest,
        changedFiles,
        request: {
            files,
            deletions,
            message: change.message,
            trailers: {
                operation: change.trailers.operation ?? 'sync',
                deviceId: change.trailers.deviceId ?? 'unknown',
                deviceName: change.trailers.deviceName ?? 'unknown',
                profile: change.profile,
                result: change.trailers.result ?? 'ok',
                itemCount: change.trailers.itemCount ?? '0',
            },
            expectedRevision: contents.revision,
            ...(change.signal === undefined ? {} : { signal: change.signal }),
        },
    };
}
/** Store path of one section document. */
export function sectionPath(profile, section) {
    return `${STORE_FILES.profilePrefix}${sanitizeProfileName(profile)}/${section}.json`;
}
/** Refuse a profile name that could escape the profile directory. */
function sanitizeProfileName(profile) {
    if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..') {
        throw new SyncError('invalid-config', `非法 profile 名称 / invalid profile name: ${profile}`);
    }
    return profile;
}
/** Device ids are generated locally; refuse anything path-like. */
function sanitizeDeviceId(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
        throw new SyncError('invalid-config', `非法设备标识 / invalid device id: ${id}`);
    }
    return id;
}
/** Read a manifest, tolerating a document from a newer schema. */
function readManifest(bytes, logger) {
    const parsed = parseJson(decode(bytes));
    if (parsed === null || typeof parsed !== 'object') {
        logger.warn('无法解析存储清单 / cannot parse the store manifest');
        return null;
    }
    if (parsed.schemaVersion > SCHEMA_VERSION) {
        logger.warn('存储由更新版本的插件写入 / the store was written by a newer plugin version', {
            stored: parsed.schemaVersion,
            supported: SCHEMA_VERSION,
        });
    }
    return {
        ...parsed,
        revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        profiles: parsed.profiles ?? {},
        digests: parsed.digests ?? {},
    };
}
function encodeJson(value) {
    return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}
function decode(bytes) {
    return new TextDecoder().decode(bytes);
}
/** Recognize the backend's concurrent-write signal. */
function toConflict(error) {
    if (error instanceof SyncError && (error.code === 'conflict' || error.code === 'busy'))
        return error;
    const coded = error;
    if (coded?.code === 'conflict' || coded?.code === 'busy')
        return new SyncError('conflict', errorMessage(error));
    return null;
}
/** Fingerprint of the whole document set, for a status read that avoids parsing. */
export function contentsDigest(contents) {
    const parts = [];
    for (const [path, bytes] of [...contents.files].sort((left, right) => left[0].localeCompare(right[0]))) {
        parts.push(`${path}:${sha256Bytes(bytes)}`);
    }
    return sha256Text(parts.join('\n'));
}
/** Narrow a section document to its items, defaulting to an empty map. */
export function sectionItems(document) {
    if (document === undefined)
        return {};
    return document.items;
}
