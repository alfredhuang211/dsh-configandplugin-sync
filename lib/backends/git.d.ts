/**
 * Git storage backend.
 *
 * The synchronized store lives in one directory (`options.storePath`) of a
 * branch in a Git repository. A local clone under `options.workDir` is a
 * **cache**: every read and every write starts by fetching the remote branch
 * and hard-resetting the work tree to it, so an interrupted earlier run can
 * never leak into a later one.
 *
 * Invariants this module owns:
 *
 * - **No credential ever reaches argv, the log or an error message.** HTTPS
 *   tokens are handed to Git through a throwaway credential helper registered
 *   in `GIT_CONFIG_*` environment variables, which the helper script reads from
 *   its own environment; the token therefore never appears in `ps`, in a shell
 *   history, or in captured output (which is redacted anyway).
 * - **Pushes never force.** `expectedRevision` is the commit the caller read:
 *   if the remote has moved since, the write fails with
 *   {@link SyncError} code `conflict` and the engine re-reads and re-merges.
 *   That is the only safe behaviour: re-applying this run's documents on top of
 *   a newer remote would silently overwrite items another device just added.
 * - **Writes are one commit.** Files are written atomically, deletions are
 *   applied first, `git add -A` stages exactly the resulting tree, and nothing
 *   is committed when the tree is already identical.
 *
 * @module backends/git
 */
import { SyncError } from '../core/errors.js';
import type { CommitTrailers, GitBackendConfig, HistoryEntry, SyncBackend } from '../types.js';
import type { BackendOptions } from './index.js';
/** Largest amount of stdout/stderr retained for one Git command (per stream). */
export declare const MAX_CAPTURED_OUTPUT_BYTES: number;
/** Exit code reported when a command was killed after its timeout. */
export declare const GIT_TIMEOUT_EXIT_CODE = 124;
/** Default per-command timeout in milliseconds. */
export declare const DEFAULT_GIT_TIMEOUT_MS = 120000;
/**
 * POSIX `sh` snippet registered as `credential.helper`.
 *
 * Git executes it for `get`; it reads the credentials from its environment at
 * that moment, so neither the token nor its base64 form is part of any argv.
 */
export declare const TOKEN_CREDENTIAL_HELPER = "!f() { printf '%s\\n' \"username=$DSH_SYNC_GIT_USER\" \"password=$DSH_SYNC_GIT_TOKEN\"; }; f";
/** Environment variable holding the HTTPS username for {@link TOKEN_CREDENTIAL_HELPER}. */
export declare const CREDENTIAL_USER_ENV = "DSH_SYNC_GIT_USER";
/** Environment variable holding the HTTPS token for {@link TOKEN_CREDENTIAL_HELPER}. */
export declare const CREDENTIAL_TOKEN_ENV = "DSH_SYNC_GIT_TOKEN";
/** Map captured Git output to one of this plugin's error codes. */
export declare function classifyGitFailure(stderr: string, timedOut: boolean): SyncError;
/**
 * Format the trailer paragraph of a commit.
 *
 * `CommitTrailers` property names are mapped onto their documented trailer
 * names (`deviceId` → `Device-Id`, ...) and one `Key: value` line is emitted per
 * trailer, so `git interpret-trailers` and {@link parseCommitTrailers} both
 * understand the result.
 */
export declare function formatCommitTrailers(trailers: CommitTrailers): string;
/**
 * Parse a commit body's trailer paragraph.
 *
 * Tolerates a missing paragraph, blank lines at either end and unknown trailer
 * keys; keys are lower-cased so `Device-Id` and `device-id` both read back.
 */
export declare function parseCommitTrailers(body: string): Record<string, string>;
/** Parse `git log` output produced with {@link HISTORY_FORMAT}. */
export declare function parseHistoryLog(stdout: string): HistoryEntry[];
/** Git `--format` string used by the history reader (`\x1e` ends each record). */
export declare const HISTORY_FORMAT = "%H%x00%h%x00%aI%x00%an%x00%s%x00%B%x1e";
/** Validate a branch name without invoking Git. */
export declare function normalizeBranchName(raw: string | undefined): string;
/**
 * Validate the repository URL and refuse anything that could leak or mislead.
 *
 * Embedded credentials are rejected instead of being stripped: silently
 * ignoring them would turn a configuration mistake into an opaque auth failure.
 */
export declare function normalizeRepoUrlInput(raw: string): string;
/**
 * Credential-free destination string for the settings page.
 *
 * Never throws: it is used while rendering a configuration that may still be
 * incomplete, and a UI string must never break the page.
 */
export declare function describeGitDestination(config: Pick<GitBackendConfig, 'repoUrl' | 'branch'>, storePath?: string): string;
/**
 * Create the Git storage backend.
 *
 * Validation happens on first use rather than at construction so the plugin can
 * be created at startup and surface `not-configured` only when a sync actually
 * needs the repository.
 */
export declare function createGitBackend(config: GitBackendConfig, options: BackendOptions): SyncBackend;
