/**
 * Model-provider normalization.
 *
 * Providers live inside the Loader entries of whichever LLM adapter declares
 * them, and different adapters spell the same idea differently: `pi-ai` keeps a
 * `providers` dict keyed by route, the DeepSeek adapter keeps one provider's
 * fields flat on the entry. This module reduces both to one
 * {@link ProviderRecord} the engine can compare and write back, plus the
 * profile's default model selection.
 *
 * A provider record never carries a credential: the entry config has already
 * been projected through `splitSecrets`, and this module applies the same rule
 * again as defence in depth, so a key configured directly (`apiKey` instead of
 * `apiKeyEnv`) is dropped rather than synchronized.
 * @module collect/providers
 */
import type { ConfigEntryRecord, ModelSelectionRecord, ProviderRecord } from '../types.js';
/** Result of normalizing the provider declarations of one profile. */
export interface ProvidersResult {
    /** One record per provider route, deduped by id (the last declaration wins). */
    providers: ProviderRecord[];
    /** The profile's default model selection, when one is declared. */
    defaultModel: ModelSelectionRecord | null;
    /** Non-fatal findings; never contains a configuration value. */
    warnings: string[];
}
/** Extract model ids from the several shapes an adapter may use. */
export declare function modelIds(value: unknown): string[];
/**
 * Normalize every provider declaration in the profile.
 *
 * Providers are deduped by id across entries (the later entry wins, which
 * matches how Loader layers override each other); the record therefore always
 * names the entry a write-back should target.
 */
export declare function collectProviders(entries: readonly ConfigEntryRecord[], warnings?: string[]): ProvidersResult;
