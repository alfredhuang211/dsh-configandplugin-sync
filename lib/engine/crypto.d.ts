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
import type { SecretsEnvelope, SecretsPayload } from '../types.js';
/**
 * Encrypt a secret payload into a store-safe envelope.
 *
 * Refuses an empty passphrase instead of writing weakly protected material: a
 * store without a passphrase must be configured as "secrets off", not silently
 * encrypted with a blank key.
 */
export declare function encryptSecrets(payload: SecretsPayload, options: {
    passphrase: string;
    deviceId: string;
    now?: () => Date;
}): Promise<SecretsEnvelope>;
/**
 * Decrypt an envelope, mapping every failure onto a stable error code.
 *
 * A wrong passphrase and a corrupted envelope are reported distinctly: the UI
 * can offer "try again" for the first and must not for the second.
 */
export declare function decryptSecrets(envelope: SecretsEnvelope, options: {
    passphrase: string;
}): Promise<SecretsPayload>;
/** A stable description of an envelope that carries no secret material. */
export declare function describeEnvelope(envelope: SecretsEnvelope | null): {
    stored: boolean;
    createdAt?: string;
    refCount?: number;
    deviceId?: string;
};
