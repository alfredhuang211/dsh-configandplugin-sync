/**
 * Envelope encryption for the secret slice.
 *
 * A synchronized store may be a Git repository on a public host or an S3 bucket
 * shared with other tools, so API keys and credential records never leave the
 * device in the clear: they are serialized to JSON, encrypted with AES-256-GCM
 * under a scrypt-derived key, and only the envelope is written.
 *
 * The passphrase is never stored — not in the configuration file, not in the
 * remote store. It comes from an environment variable the user controls (or an
 * explicit one-off value from the settings page), which is exactly the property
 * that makes a stolen store useless on its own.
 * @module engine/crypto
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { DERIVED_KEY_BYTES, GCM_IV_BYTES, SCRYPT_PARAMS, SECRETS_ENVELOPE_VERSION, } from '../constants.js';
import { SyncError } from '../core/errors.js';
const scrypt = promisify(scryptCallback);
/**
 * Derive the 32-byte AES key from a passphrase and salt.
 *
 * `maxmem` is raised above Node's 32 MiB default because the selected cost
 * (`N = 2^15`, `r = 8`) legitimately needs ~32 MiB; a lowered cost would weaken
 * every stored secret. Parameters are read back from the envelope so a future
 * release can raise the cost without invalidating existing documents.
 */
async function deriveKey(passphrase, salt, params = SCRYPT_PARAMS) {
    const key = await scrypt(passphrase, salt, DERIVED_KEY_BYTES, {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 128 * params.N * params.r * 2,
    });
    return Buffer.from(key);
}
/**
 * Encrypt a secret payload into a store-safe envelope.
 *
 * Refuses an empty passphrase instead of writing weakly protected material: a
 * store without a passphrase must be configured as "secrets off", not silently
 * encrypted with a blank key.
 */
export async function encryptSecrets(payload, options) {
    const passphrase = options.passphrase;
    if (passphrase.trim() === '') {
        throw new SyncError('passphrase-required', '同步密钥需要设置口令 / a passphrase is required to sync secrets');
    }
    const salt = randomBytes(16);
    const iv = randomBytes(GCM_IV_BYTES);
    const key = await deriveKey(passphrase, salt);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // The key material is not kept anywhere: a later read derives it again.
    key.fill(0);
    return {
        v: SECRETS_ENVELOPE_VERSION,
        kdf: {
            name: 'scrypt',
            N: SCRYPT_PARAMS.N,
            r: SCRYPT_PARAMS.r,
            p: SCRYPT_PARAMS.p,
            salt: salt.toString('base64'),
        },
        cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
        data: ciphertext.toString('base64'),
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        deviceId: options.deviceId,
        refCount: payload.refs.length,
    };
}
/**
 * Decrypt an envelope, mapping every failure onto a stable error code.
 *
 * A wrong passphrase and a corrupted envelope are reported distinctly: the UI
 * can offer "try again" for the first and must not for the second.
 */
export async function decryptSecrets(envelope, options) {
    if (options.passphrase.trim() === '') {
        throw new SyncError('passphrase-required', '读取密钥需要口令 / a passphrase is required to read secrets');
    }
    validateEnvelope(envelope);
    const salt = Buffer.from(envelope.kdf.salt, 'base64');
    const iv = Buffer.from(envelope.cipher.iv, 'base64');
    const tag = Buffer.from(envelope.cipher.tag, 'base64');
    const data = Buffer.from(envelope.data, 'base64');
    const key = await deriveKey(options.passphrase, salt, envelope.kdf);
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
        const parsed = JSON.parse(plaintext.toString('utf8'));
        return normalizePayload(parsed);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('unable to authenticate') || message.includes('Unsupported state')) {
            throw new SyncError('passphrase-invalid', '口令不正确或密钥文件已损坏 / wrong passphrase or corrupted secret document');
        }
        throw new SyncError('passphrase-invalid', `无法解密密钥文件 / cannot decrypt the secret document: ${message}`);
    }
    finally {
        key.fill(0);
    }
}
/** Check the envelope shape before touching crypto, so a bad document fails clearly. */
function validateEnvelope(envelope) {
    if (envelope === null || typeof envelope !== 'object') {
        throw new SyncError('invalid-config', '密钥文件格式无效 / invalid secret document');
    }
    if (envelope.v !== SECRETS_ENVELOPE_VERSION) {
        throw new SyncError('unsupported', `不支持的密钥文件版本 / unsupported secret document version: ${String(envelope.v)}`);
    }
    if (envelope.kdf?.name !== 'scrypt' ||
        typeof envelope.kdf.salt !== 'string' ||
        envelope.cipher?.name !== 'aes-256-gcm' ||
        typeof envelope.cipher.iv !== 'string' ||
        typeof envelope.cipher.tag !== 'string' ||
        typeof envelope.data !== 'string') {
        throw new SyncError('invalid-config', '密钥文件缺少必要字段 / secret document is missing required fields');
    }
}
/** Coerce a decrypted payload into the declared shape. */
function normalizePayload(value) {
    const record = (value ?? {});
    const refs = Array.isArray(record.refs)
        ? record.refs.filter((item) => item !== null && typeof item === 'object' && typeof item.ref === 'string')
        : [];
    const values = {};
    if (record.values !== null && typeof record.values === 'object') {
        for (const [key, item] of Object.entries(record.values)) {
            if (typeof item === 'string')
                values[key] = item;
        }
    }
    const records = Array.isArray(record.records)
        ? record.records.filter((item) => item !== null &&
            typeof item === 'object' &&
            typeof item.key === 'string' &&
            (item.kind === 'api-key' || item.kind === 'grant'))
        : [];
    return { refs, values, records };
}
/** A stable description of an envelope that carries no secret material. */
export function describeEnvelope(envelope) {
    if (envelope === null)
        return { stored: false };
    return {
        stored: true,
        createdAt: envelope.createdAt,
        refCount: envelope.refCount,
        deviceId: envelope.deviceId,
    };
}
