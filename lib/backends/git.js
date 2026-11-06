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
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_BRANCH, HISTORY_LIMIT, MAX_DOCUMENT_BYTES, MAX_STORE_FILES } from '../constants.js';
import { SyncError, errorMessage } from '../core/errors.js';
import { normalizeStorePath } from '../core/paths.js';
import { redactText, sanitizeUrl } from '../core/redact.js';
/** Largest amount of stdout/stderr retained for one Git command (per stream). */
export const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
/** Exit code reported when a command was killed after its timeout. */
export const GIT_TIMEOUT_EXIT_CODE = 124;
/** Default per-command timeout in milliseconds. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
/**
 * POSIX `sh` snippet registered as `credential.helper`.
 *
 * Git executes it for `get`; it reads the credentials from its environment at
 * that moment, so neither the token nor its base64 form is part of any argv.
 */
export const TOKEN_CREDENTIAL_HELPER = `!f() { printf '%s\\n' "username=$DSH_SYNC_GIT_USER" "password=$DSH_SYNC_GIT_TOKEN"; }; f`;
/** Environment variable holding the HTTPS username for {@link TOKEN_CREDENTIAL_HELPER}. */
export const CREDENTIAL_USER_ENV = 'DSH_SYNC_GIT_USER';
/** Environment variable holding the HTTPS token for {@link TOKEN_CREDENTIAL_HELPER}. */
export const CREDENTIAL_TOKEN_ENV = 'DSH_SYNC_GIT_TOKEN';
/** Canonical trailer names written into the commit body. */
/**
 * Work directories are shared between backend instances (one is created per
 * operation), so serialization has to be process-wide: two concurrent reads of
 * the same cache would otherwise race on `git remote`, `fetch` and `reset`.
 */
const workDirQueues = new Map();
/** Run one task exclusively for a work directory. */
async function withWorkDirLock(workDir, task) {
    const key = resolve(workDir);
    const previous = workDirQueues.get(key) ?? Promise.resolve();
    let release = () => undefined;
    const gate = new Promise(resolveGate => {
        release = resolveGate;
    });
    workDirQueues.set(key, previous.then(() => gate, () => gate));
    try {
        await previous.catch(() => undefined);
        return await task();
    }
    finally {
        release();
    }
}
const TRAILER_NAMES = {
    operation: 'Operation',
    deviceId: 'Device-Id',
    deviceName: 'Device-Name',
    profile: 'Profile',
    result: 'Result',
    itemCount: 'Item-Count',
};
/** Git errors that mean "Git wanted credentials and could not get them". */
const AUTH_FAILURE_PATTERNS = [
    /authentication failed/i,
    /could not read (?:username|password)/i,
    /permission denied \(publickey\)/i,
    /terminal prompts disabled/i,
    /invalid username or password/i,
    /support for password authentication was removed/i,
    /host key verification failed/i,
    /returned error: (?:401|403)/i,
    /\b401 unauthorized\b/i,
    /\b403 forbidden\b/i,
];
/** Git errors caused by the network rather than by the repository contents. */
const NETWORK_FAILURE_PATTERNS = [
    /could not resolve host/i,
    /could not resolve proxy/i,
    /connection timed out/i,
    /connection refused/i,
    /connection reset/i,
    /operation timed out/i,
    /network is unreachable/i,
    /no route to host/i,
    /unable to access/i,
    /ssl certificate problem/i,
    /ssl error/i,
    /tls handshake/i,
    /rpc failed/i,
    /remote end hung up/i,
    /early eof/i,
    /unexpected disconnect while reading sideband packet/i,
];
/** Git errors that mean the repository or branch does not exist. */
const NOT_FOUND_PATTERNS = [
    /repository .* not found/i,
    /does not appear to be a git repository/i,
    /not a git repository/i,
    /couldn't find remote ref/i,
    /remote branch .* not found/i,
    /no such file or directory/i,
    /repository not found/i,
];
/** Log at debug level without ever letting a logger failure break a command. */
function safeLog(logger, message, details) {
    try {
        if (details === undefined)
            logger.debug(redactText(message));
        else
            logger.debug(redactText(message), details);
    }
    catch {
        // Diagnostics are best effort.
    }
}
/** Append one chunk to a capture while enforcing its byte cap. */
function captureChunk(capture, chunk, limit) {
    if (capture.bytes >= limit) {
        capture.truncated = true;
        return;
    }
    const room = limit - capture.bytes;
    if (chunk.length > room) {
        capture.chunks.push(chunk.subarray(0, room));
        capture.bytes = limit;
        capture.truncated = true;
    }
    else {
        capture.chunks.push(chunk);
        capture.bytes += chunk.length;
    }
}
/** Materialize a capture as UTF-8 text. */
function captureText(capture) {
    const text = Buffer.concat(capture.chunks).toString('utf8');
    return capture.truncated ? `${text}\n[output truncated]` : text;
}
/** Render captured stderr as a short, redacted, single-line detail. */
function summarizeGitFailure(stderr) {
    const lines = redactText(stderr)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('hint:'));
    const preferred = lines.find(line => /^(?:fatal|error):/i.test(line)) ??
        lines.find(line => /^(?:remote:)/i.test(line)) ??
        lines[0] ??
        '';
    const cleaned = preferred.replace(/^(?:fatal|error|remote):\s*/i, '').trim();
    return cleaned.length > 400 ? `${cleaned.slice(0, 400)}…` : cleaned;
}
/** Append a detail clause only when a detail exists. */
function withDetail(message, detail) {
    return detail === '' ? message : `${message}: ${detail}`;
}
/** Map captured Git output to one of this plugin's error codes. */
export function classifyGitFailure(stderr, timedOut) {
    const safe = redactText(stderr);
    const detail = summarizeGitFailure(safe);
    if (timedOut) {
        return new SyncError('network', withDetail('Git 操作超时 / git operation timed out', detail));
    }
    if (AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(safe))) {
        return new SyncError('auth-failed', withDetail('Git 认证失败 / git authentication failed', detail));
    }
    if (NETWORK_FAILURE_PATTERNS.some(pattern => pattern.test(safe))) {
        return new SyncError('network', withDetail('Git 网络错误 / git network error', detail));
    }
    if (NOT_FOUND_PATTERNS.some(pattern => pattern.test(safe))) {
        return new SyncError('not-found', withDetail('Git 仓库或分支不存在 / git repository or branch not found', detail));
    }
    return new SyncError('internal', withDetail('Git 命令失败 / git command failed', detail));
}
/** Sanitize one trailer value to a single short line. */
function sanitizeTrailerValue(value) {
    const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return line.length > 500 ? line.slice(0, 500) : line;
}
/** Sanitize one trailer key; unknown keys are dropped unless they are valid. */
function sanitizeTrailerKey(key) {
    const canonical = TRAILER_NAMES[key] ?? key;
    return /^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(canonical) ? canonical : '';
}
/**
 * Format the trailer paragraph of a commit.
 *
 * `CommitTrailers` property names are mapped onto their documented trailer
 * names (`deviceId` → `Device-Id`, ...) and one `Key: value` line is emitted per
 * trailer, so `git interpret-trailers` and {@link parseCommitTrailers} both
 * understand the result.
 */
export function formatCommitTrailers(trailers) {
    const lines = [];
    const written = new Set();
    for (const [property, name] of Object.entries(TRAILER_NAMES)) {
        const value = trailers[property];
        if (typeof value !== 'string' || value === '')
            continue;
        const safeValue = sanitizeTrailerValue(value);
        if (safeValue === '')
            continue;
        lines.push(`${name}: ${safeValue}`);
        written.add(property);
    }
    for (const [property, value] of Object.entries(trailers)) {
        if (written.has(property) || typeof value !== 'string' || value === '')
            continue;
        const key = sanitizeTrailerKey(property);
        const safeValue = sanitizeTrailerValue(value);
        if (key === '' || safeValue === '')
            continue;
        lines.push(`${key}: ${safeValue}`);
    }
    return lines.join('\n');
}
/**
 * Parse a commit body's trailer paragraph.
 *
 * Tolerates a missing paragraph, blank lines at either end and unknown trailer
 * keys; keys are lower-cased so `Device-Id` and `device-id` both read back.
 */
export function parseCommitTrailers(body) {
    const trailers = {};
    if (typeof body !== 'string' || body === '')
        return trailers;
    const lines = body.split(/\r?\n/);
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '')
        lines.pop();
    while (lines.length > 0 && (lines[0] ?? '').trim() === '')
        lines.shift();
    // A trailer block counts only when it is the last paragraph, separated from
    // the subject by a blank line. A body that consists of nothing but trailer
    // lines is accepted too, so `parseCommitTrailers(formatCommitTrailers(x))`
    // round-trips without the caller having to add the separator.
    let start = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if ((lines[index] ?? '').trim() === '') {
            start = index + 1;
            break;
        }
    }
    if (start < 0) {
        const looksLikeTrailers = lines.every(line => /^[A-Za-z][A-Za-z0-9-]{0,40}:\s*\S/.test(line.trim()));
        if (!looksLikeTrailers)
            return trailers;
        start = 0;
    }
    for (let index = start; index < lines.length; index += 1) {
        const match = /^([A-Za-z][A-Za-z0-9-]{0,40}):\s*(.*)$/.exec((lines[index] ?? '').trim());
        if (match === null)
            continue;
        const key = (match[1] ?? '').toLowerCase();
        const value = (match[2] ?? '').trim();
        if (key !== '')
            trailers[key] = value;
    }
    return trailers;
}
/** Parse `git log` output produced with {@link HISTORY_FORMAT}. */
export function parseHistoryLog(stdout) {
    const entries = [];
    for (const rawRecord of stdout.split('\x1e')) {
        const record = rawRecord.replace(/^\r?\n/, '');
        if (record.trim() === '')
            continue;
        const fields = record.split('\x00');
        if (fields.length < 6)
            continue;
        const commit = fields[0] ?? '';
        const shortCommit = fields[1] ?? '';
        const date = fields[2] ?? '';
        const author = redactText(fields[3] ?? '');
        const subject = redactText(fields[4] ?? '');
        const body = fields.slice(5).join('\x00');
        if (commit === '')
            continue;
        const trailers = parseCommitTrailers(body);
        const entry = {
            commit,
            shortCommit,
            date,
            author,
            subject,
            operation: trailers.operation ?? 'unknown',
        };
        const deviceId = trailers['device-id'] ?? trailers.deviceid;
        if (deviceId !== undefined && deviceId !== '')
            entry.deviceId = deviceId;
        const deviceName = trailers['device-name'] ?? trailers.devicename;
        if (deviceName !== undefined && deviceName !== '')
            entry.deviceName = deviceName;
        if (trailers.profile !== undefined && trailers.profile !== '')
            entry.profile = trailers.profile;
        const itemCount = trailers['item-count'] ?? trailers.itemcount;
        if (itemCount !== undefined && /^\d+$/.test(itemCount))
            entry.itemCount = Number.parseInt(itemCount, 10);
        if (trailers.result !== undefined && trailers.result !== '')
            entry.result = trailers.result;
        entries.push(entry);
    }
    return entries;
}
/** Git `--format` string used by the history reader (`\x1e` ends each record). */
export const HISTORY_FORMAT = '%H%x00%h%x00%aI%x00%an%x00%s%x00%B%x1e';
/** Strip any userinfo from a repository URL, for display only. */
function displayRepoUrl(repoUrl) {
    // scp-like `user@host:path`: the user is part of SSH addressing, not a secret,
    // but it is still unnecessary in a UI string.
    const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(repoUrl);
    if (scp !== null)
        return `${scp[2] ?? ''}:${scp[3] ?? ''}`;
    try {
        const url = new URL(repoUrl);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    }
    catch {
        return sanitizeUrl(repoUrl);
    }
}
/** Validate a branch name without invoking Git. */
export function normalizeBranchName(raw) {
    const branch = (raw ?? '').trim();
    if (branch === '')
        throw new SyncError('not-configured', '尚未配置 Git 分支 / the git branch is not configured');
    if (branch.length > 200) {
        throw new SyncError('invalid-config', '分支名过长 / the git branch name is too long');
    }
    if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(branch) ||
        branch.startsWith('-') ||
        branch.startsWith('/') ||
        branch.endsWith('/') ||
        branch.includes('..') ||
        branch.includes('@{') ||
        branch.endsWith('.') ||
        branch.endsWith('.lock') ||
        branch === 'HEAD') {
        throw new SyncError('invalid-config', `分支名无效 / invalid git branch name: ${JSON.stringify(branch)}`);
    }
    return branch;
}
/** Whether a repository URL is an HTTPS URL that can carry a token. */
function isHttpsRepoUrl(repoUrl) {
    return /^https?:\/\//i.test(repoUrl);
}
/** Normalize a repository URL: local paths become absolute. */
function normalizeRepoUrl(raw) {
    const trimmed = raw.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed))
        return trimmed;
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(trimmed))
        return trimmed;
    return resolve(trimmed);
}
/**
 * Validate the repository URL and refuse anything that could leak or mislead.
 *
 * Embedded credentials are rejected instead of being stripped: silently
 * ignoring them would turn a configuration mistake into an opaque auth failure.
 */
export function normalizeRepoUrlInput(raw) {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') {
        throw new SyncError('not-configured', '尚未配置 Git 仓库 / the git repository is not configured');
    }
    if (trimmed.includes('\u0000') || /[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new SyncError('invalid-config', '仓库地址包含控制字符 / the repository URL contains control characters');
    }
    if (trimmed.startsWith('-')) {
        throw new SyncError('invalid-config', '仓库地址不能以 - 开头 / the repository URL must not start with -');
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        let url;
        try {
            url = new URL(trimmed);
        }
        catch {
            throw new SyncError('invalid-config', `仓库地址无效 / invalid repository URL: ${redactText(trimmed)}`);
        }
        if (url.password !== '') {
            throw new SyncError('invalid-config', '仓库地址不能内嵌凭据，请使用认证设置 / the repository URL must not embed credentials; use the authentication settings');
        }
        if (url.username !== '' && url.protocol !== 'ssh:' && url.protocol !== 'git+ssh:') {
            throw new SyncError('invalid-config', '仓库地址不能内嵌用户名，请使用认证设置 / the repository URL must not embed a username; use the authentication settings');
        }
        return normalizeRepoUrl(trimmed);
    }
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(trimmed))
        return trimmed;
    return normalizeRepoUrl(trimmed);
}
/** Whether a failed fetch only means "the branch does not exist on the remote". */
function isMissingRemoteRef(result) {
    return /(?:couldn't|could not|no such) (?:find )?remote ref/i.test(`${result.stderr}\n${result.stdout}`);
}
/** Whether a rejected push means "another commit landed first". */
function isNonFastForwardPush(result) {
    const text = `${result.stderr}\n${result.stdout}`;
    if (/remote rejected|pre-receive hook|hook declined|protected branch|GH006|GH013/i.test(text))
        return false;
    return /non-fast-forward|fetch first|updates were rejected|failed to push some refs|\[rejected\]/i.test(text);
}
/** Parse `git status --porcelain -z` output into work-tree-relative paths. */
function parsePorcelainZ(stdout) {
    const tokens = stdout.split('\x00');
    const paths = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        if (token.length < 4)
            continue;
        const status = token.slice(0, 2);
        const path = token.slice(3);
        // Rename/copy entries carry the original path in a following token.
        if (status.startsWith('R') || status.startsWith('C'))
            index += 1;
        if (path !== '')
            paths.push(path);
    }
    return paths;
}
/** Convert an absolute or platform path into a store-relative POSIX path. */
function toStoreRelative(root, absolute) {
    return relative(root, absolute).split(sep).join('/');
}
/** Attach a `cause` to a SyncError without replacing the typed error. */
function rethrowSync(error, fallbackCode) {
    if (error instanceof SyncError)
        throw error;
    if (error?.name === 'AbortError') {
        throw new SyncError('cancelled', '操作已取消 / operation cancelled');
    }
    throw new SyncError(fallbackCode, redactText(errorMessage(error)));
}
/** Whether a store-relative path is safe to touch on disk. */
function safeStorePath(path) {
    try {
        return normalizeStorePath(path);
    }
    catch (error) {
        throw new SyncError('invalid-config', redactText(errorMessage(error)));
    }
}
/**
 * Credential-free destination string for the settings page.
 *
 * Never throws: it is used while rendering a configuration that may still be
 * incomplete, and a UI string must never break the page.
 */
export function describeGitDestination(config, storePath = '') {
    const rawUrl = (config.repoUrl ?? '').trim();
    const repo = rawUrl === '' ? '(未配置 / not configured)' : displayRepoUrl(normalizeRepoUrlLoose(rawUrl));
    const branch = (config.branch ?? '').trim() || DEFAULT_BRANCH;
    const path = (storePath ?? '').trim();
    return `git ${repo}#${branch}${path === '' ? '' : ` (${path})`}`;
}
/** Normalize a repository URL without validating it (display only). */
function normalizeRepoUrlLoose(raw) {
    try {
        return normalizeRepoUrl(raw);
    }
    catch {
        return redactText(raw);
    }
}
/**
 * Create the Git storage backend.
 *
 * Validation happens on first use rather than at construction so the plugin can
 * be created at startup and surface `not-configured` only when a sync actually
 * needs the repository.
 */
export function createGitBackend(config, options) {
    const logger = options.logger;
    const kind = 'git';
    const workDir = resolve(options.workDir);
    let cachedSettings = null;
    const settings = () => {
        if (cachedSettings !== null)
            return cachedSettings;
        const repoUrl = normalizeRepoUrlInput(config.repoUrl);
        const branch = normalizeBranchName(config.branch);
        const rawStorePath = (options.storePath ?? '').trim();
        let storePath = '';
        if (rawStorePath !== '' && rawStorePath !== '.') {
            try {
                storePath = normalizeStorePath(rawStorePath);
            }
            catch (error) {
                throw new SyncError('invalid-config', redactText(errorMessage(error)));
            }
        }
        const root = storePath === '' ? workDir : join(workDir, ...storePath.split('/'));
        cachedSettings = { repoUrl, branch, root, storePath };
        return cachedSettings;
    };
    /** Build the child environment, injecting HTTPS credentials out of argv. */
    const buildEnvironment = async (extraEnv) => {
        const env = { ...process.env, ...extraEnv };
        // Never prompt interactively; make diagnostics stable and parseable.
        env.GIT_TERMINAL_PROMPT = '0';
        env.GIT_OPTIONAL_LOCKS = '0';
        env.LC_ALL = 'C';
        env.LANG = 'C';
        env.GCM_INTERACTIVE = 'never';
        env.GIT_EDITOR = 'true';
        const current = settings();
        if (config.authMode !== 'https-token' || !isHttpsRepoUrl(current.repoUrl))
            return env;
        let credentials = null;
        if (options.tokenProvider !== undefined) {
            try {
                credentials = await options.tokenProvider();
            }
            catch (error) {
                throw new SyncError('auth-failed', '无法读取 Git 访问令牌 / failed to read the git access token', {
                    cause: errorMessage(error),
                });
            }
        }
        if (credentials === null || credentials.token.trim() === '') {
            const envName = (config.tokenEnvVar ?? '').trim();
            throw new SyncError('auth-required', envName === ''
                ? 'HTTPS 令牌模式已启用，但未找到访问令牌 / https-token mode is enabled but no access token is available'
                : `HTTPS 令牌模式已启用，但环境变量 ${envName} 为空 / https-token mode is enabled but the environment variable ${envName} is empty`);
        }
        const username = credentials.username.trim() === '' ? 'token' : credentials.username.trim();
        // Pass the helper through Git's environment configuration interface instead
        // of `-c`, which would put it (and, for an inline helper, the secret) into argv.
        const parsedCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
        const index = Number.isInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
        env.GIT_CONFIG_COUNT = String(index + 1);
        env[`GIT_CONFIG_KEY_${index}`] = 'credential.helper';
        env[`GIT_CONFIG_VALUE_${index}`] = TOKEN_CREDENTIAL_HELPER;
        env[CREDENTIAL_USER_ENV] = username;
        env[CREDENTIAL_TOKEN_ENV] = credentials.token;
        return env;
    };
    /** Run one Git command, capturing and redacting its output. */
    const runGit = async (args, runOptions = {}) => {
        const signal = runOptions.signal;
        if (signal?.aborted === true) {
            throw new SyncError('cancelled', 'Git 操作已取消 / git operation cancelled');
        }
        for (const arg of args) {
            if (typeof arg !== 'string' || arg === '' || arg.includes('\u0000')) {
                throw new SyncError('internal', '非法的 Git 参数 / invalid git argument');
            }
        }
        const env = await buildEnvironment(runOptions.env);
        let child;
        try {
            child = spawn('git', args, { cwd: runOptions.cwd, env, windowsHide: true });
        }
        catch (error) {
            throw new SyncError('internal', redactText(`无法启动 Git / failed to start git: ${errorMessage(error)}`));
        }
        const stdoutCapture = { chunks: [], bytes: 0, truncated: false };
        const stderrCapture = { chunks: [], bytes: 0, truncated: false };
        return await new Promise((resolvePromise, rejectPromise) => {
            let settled = false;
            let timedOut = false;
            let aborted = false;
            let timer;
            const cleanup = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                rejectPromise(error);
            };
            const finish = (code) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                if (aborted) {
                    rejectPromise(new SyncError('cancelled', 'Git 操作已取消 / git operation cancelled'));
                    return;
                }
                const stdoutBuffer = Buffer.concat(stdoutCapture.chunks);
                const effectiveCode = timedOut ? GIT_TIMEOUT_EXIT_CODE : code === null ? 1 : code;
                safeLog(logger, `git ${args.join(' ')}`, {
                    code: effectiveCode,
                    timedOut,
                    stdoutBytes: stdoutCapture.bytes,
                    stderrBytes: stderrCapture.bytes,
                });
                resolvePromise({
                    code: effectiveCode,
                    stdout: redactText(captureText(stdoutCapture)),
                    stdoutBuffer,
                    stderr: redactText(captureText(stderrCapture)),
                    timedOut,
                });
            };
            const onAbort = () => {
                aborted = true;
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // The child may already be gone.
                }
            };
            if (signal !== undefined)
                signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // The child may already be gone.
                }
            }, DEFAULT_GIT_TIMEOUT_MS);
            timer.unref?.();
            child.stdout?.on('data', (chunk) => {
                captureChunk(stdoutCapture, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk, MAX_CAPTURED_OUTPUT_BYTES);
            });
            child.stderr?.on('data', (chunk) => {
                captureChunk(stderrCapture, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk, MAX_CAPTURED_OUTPUT_BYTES);
            });
            child.on('error', (error) => {
                const errno = error.code;
                if (errno === 'ENOENT') {
                    fail(new SyncError('internal', '找不到 Git 可执行文件，请先安装 Git / the git executable was not found; install git first'));
                    return;
                }
                fail(new SyncError('internal', redactText(`Git 进程错误 / git process error: ${error.message}`)));
            });
            child.on('close', (code) => {
                finish(code);
            });
        });
    };
    /** Run a Git command and classify a non-zero exit as a typed error. */
    const runGitOrThrow = async (args, runOptions = {}) => {
        const result = await runGit(args, runOptions);
        if (result.code !== 0) {
            throw classifyGitFailure(result.stderr.length > 0 ? result.stderr : result.stdout, result.timedOut);
        }
        return result;
    };
    /** Current HEAD commit, or null in an unborn/empty repository. */
    const readHead = async (signal) => {
        const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: workDir, signal });
        if (result.code !== 0)
            return null;
        const head = result.stdout.trim();
        return head === '' ? null : head;
    };
    /** Whether `workDir` is already a Git work tree. */
    const isGitWorkTree = async () => {
        try {
            const info = await stat(join(workDir, '.git'));
            return info.isDirectory() || info.isFile();
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            rethrowSync(error, 'internal');
        }
    };
    /** Point `origin` at the configured URL, creating the remote when absent. */
    const ensureRemote = async (repoUrl, signal) => {
        const setUrl = await runGit(['remote', 'set-url', 'origin', repoUrl], { cwd: workDir, signal });
        if (setUrl.code === 0)
            return;
        const addRemote = await runGit(['remote', 'add', 'origin', repoUrl], { cwd: workDir, signal });
        if (addRemote.code === 0)
            return;
        const message = `${addRemote.stderr}\n${addRemote.stdout}`;
        // Two concurrent preparations of the same work directory can both observe
        // "no origin yet": the loser's `add` then reports that the remote exists.
        // That is not a failure — the remote now points where this run wants it.
        if (/already exists/i.test(message)) {
            const retry = await runGit(['remote', 'set-url', 'origin', repoUrl], { cwd: workDir, signal });
            if (retry.code === 0)
                return;
        }
        throw classifyGitFailure(message, addRemote.timedOut);
    };
    /**
     * Clone if needed, fetch the branch and hard-reset the work tree to it.
     *
     * Handles every shape of a fresh repository: an empty remote, a remote whose
     * branch does not exist yet, a detached work tree and a deleted branch.
     */
    const prepare = async (signal) => {
        const { repoUrl, branch } = settings();
        await mkdir(workDir, { recursive: true, mode: 0o700 });
        const existed = await isGitWorkTree();
        if (!existed) {
            const entries = await readdir(workDir);
            if (entries.length > 0) {
                throw new SyncError('invalid-config', `工作目录非空且不是 Git 仓库 / the work directory is not empty and is not a git repository: ${workDir}`);
            }
            logger.info('cloning the sync repository');
            const clone = await runGit(['clone', '--no-checkout', '--origin', 'origin', repoUrl, workDir], {
                cwd: dirname(workDir),
                signal,
            });
            if (clone.code !== 0) {
                throw classifyGitFailure(clone.stderr.length > 0 ? clone.stderr : clone.stdout, clone.timedOut);
            }
        }
        await ensureRemote(repoUrl, signal);
        const remoteRef = `refs/remotes/origin/${branch}`;
        const fetch = await runGit(['fetch', '--prune', 'origin', `+refs/heads/${branch}:${remoteRef}`], {
            cwd: workDir,
            signal,
        });
        const originExists = fetch.code === 0;
        if (!originExists) {
            if (!isMissingRemoteRef(fetch)) {
                throw classifyGitFailure(fetch.stderr.length > 0 ? fetch.stderr : fetch.stdout, fetch.timedOut);
            }
            // First push (or the branch was deleted): drop any stale remote-tracking
            // ref so the emptiness check below is honest.
            await runGit(['update-ref', '-d', remoteRef], { cwd: workDir, signal });
        }
        if (originExists) {
            await runGitOrThrow(['reset', '--hard', remoteRef], { cwd: workDir, signal });
            await runGitOrThrow(['checkout', '-B', branch, remoteRef], { cwd: workDir, signal });
        }
        else {
            // A remote without the branch is an empty store. A work tree that still
            // has a HEAD is either a cache left over from a *different* store (the
            // work directory is reused across configuration changes) or the remains
            // of an interrupted run; treating it as store content would resurrect
            // unrelated documents — including another store's configuration — in the
            // new one. The remote is the source of truth, so drop it.
            const staleHead = await readHead(signal);
            if (staleHead !== null) {
                logger.warn('discarding a cached work tree for a store whose branch is empty', {
                    branch,
                });
                await runGit(['checkout', '--detach'], { cwd: workDir, signal });
                await runGit(['update-ref', '-d', `refs/heads/${branch}`], { cwd: workDir, signal });
                await runGit(['read-tree', '--empty'], { cwd: workDir, signal });
                await runGit(['clean', '-fdxq'], { cwd: workDir, signal });
                // `-B` would recreate the branch at the stale HEAD; `--orphan` starts an
                // unborn branch, which is what "the store has no commits" means.
                await runGitOrThrow(['checkout', '--orphan', branch], { cwd: workDir, signal });
            }
            else {
                await runGitOrThrow(['checkout', '-B', branch], { cwd: workDir, signal });
            }
        }
        const head = await readHead(signal);
        if (head !== null) {
            // The work tree must match HEAD exactly, otherwise `git add -A` would
            // commit leftovers from an interrupted run.
            await runGitOrThrow(['reset', '--hard', 'HEAD'], { cwd: workDir, signal });
        }
        // Drop untracked leftovers from an interrupted run; the work tree is only a
        // cache, so nothing a user cares about can be lost here.
        await runGit(['clean', '-fdxq', '--', settings().storePath === '' ? '.' : settings().storePath], {
            cwd: workDir,
            signal,
        });
        return { head, created: !existed && !originExists };
    };
    /** Normalize the caller's file map into safe, unique store-relative paths. */
    const normalizeRequestFiles = (files) => {
        if (!(files instanceof Map)) {
            throw new SyncError('invalid-config', '待写入文件必须是映射 / files must be a Map');
        }
        if (files.size > MAX_STORE_FILES) {
            throw new SyncError('invalid-config', `文件数量超过上限 ${MAX_STORE_FILES} / too many files (limit ${MAX_STORE_FILES})`);
        }
        const out = [];
        const seen = new Set();
        for (const [rawPath, bytes] of files) {
            const path = safeStorePath(rawPath);
            if (seen.has(path)) {
                throw new SyncError('invalid-config', `重复的文件路径 / duplicate store path: ${path}`);
            }
            seen.add(path);
            if (!(bytes instanceof Uint8Array)) {
                throw new SyncError('invalid-config', `文件内容必须是字节 / file content must be bytes: ${path}`);
            }
            if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
                throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`);
            }
            out.push({ path, bytes });
        }
        out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        return out;
    };
    /** Normalize the caller's deletion list into unique store-relative paths. */
    const normalizeRequestDeletions = (deletions) => {
        if (!Array.isArray(deletions)) {
            throw new SyncError('invalid-config', 'deletions 必须是数组 / deletions must be an array');
        }
        if (deletions.length > MAX_STORE_FILES) {
            throw new SyncError('invalid-config', `删除数量超过上限 ${MAX_STORE_FILES} / too many deletions (limit ${MAX_STORE_FILES})`);
        }
        const out = [];
        const seen = new Set();
        for (const rawPath of deletions) {
            const path = safeStorePath(rawPath);
            if (seen.has(path))
                continue;
            seen.add(path);
            out.push(path);
        }
        return out;
    };
    /** Copy a file about to be overwritten or deleted into the safety directory. */
    const backupExisting = async (absolute, storeRelative, stamp) => {
        const backupDir = options.backupDir;
        if (backupDir === undefined || backupDir.trim() === '')
            return;
        try {
            const target = join(backupDir, stamp, ...storeRelative.split('/'));
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await copyFile(absolute, target);
        }
        catch (error) {
            // A safety copy is best effort; never fail the synchronization over it.
            logger.warn('failed to back up a work tree file', { path: storeRelative, error: redactText(errorMessage(error)) });
        }
    };
    /** Resolve a store-relative path to its absolute work-tree path. */
    const resolveStoreFile = (root, storeRelative) => {
        const absolute = join(root, ...storeRelative.split('/'));
        const rel = relative(workDir, absolute);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new SyncError('invalid-config', `文件路径越界 / store path escapes the work tree: ${storeRelative}`);
        }
        return absolute;
    };
    /** Write one file atomically via a sibling temporary file. */
    const writeAtomic = async (absolute, bytes) => {
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
        const temporary = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}`;
        try {
            await writeFile(temporary, bytes, { mode: 0o600 });
            await rename(temporary, absolute);
        }
        catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            rethrowSync(error, 'internal');
        }
    };
    /** Apply one write to the work tree; returns the paths that may have changed. */
    const applyWrite = async (files, deletions, signal) => {
        const { root } = settings();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const deletion of deletions) {
            if (signal?.aborted === true)
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            const absolute = resolveStoreFile(root, deletion);
            try {
                await stat(absolute);
                await backupExisting(absolute, deletion, stamp);
                await unlink(absolute);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
                rethrowSync(error, 'internal');
            }
        }
        for (const file of files) {
            if (signal?.aborted === true)
                throw new SyncError('cancelled', '操作已取消 / operation cancelled');
            const absolute = resolveStoreFile(root, file.path);
            try {
                const info = await stat(absolute);
                if (info.isFile())
                    await backupExisting(absolute, file.path, stamp);
            }
            catch {
                // A new file has nothing to back up.
            }
            await writeAtomic(absolute, file.bytes);
        }
        // Remove directories the deletions emptied, up to (but never including) the store root.
        for (const deletion of deletions) {
            let directory = dirname(resolveStoreFile(root, deletion));
            while (directory.startsWith(`${root}${sep}`)) {
                try {
                    const entries = await readdir(directory);
                    if (entries.length > 0)
                        break;
                    await rm(directory, { recursive: false });
                }
                catch {
                    break;
                }
                directory = dirname(directory);
            }
        }
    };
    /** Author/committer identity derived from the trailers, never from the host. */
    const commitEnvironment = (trailers) => {
        const rawName = redactText(typeof trailers.deviceName === 'string' ? trailers.deviceName : '');
        const name = rawName
            .replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 64);
        const authorName = name === '' ? 'DSH Config Sync' : name;
        const rawId = typeof trailers.deviceId === 'string' ? trailers.deviceId : '';
        const safeId = /^[A-Za-z0-9._-]{1,64}$/.test(rawId) ? rawId : 'device';
        const authorEmail = `${safeId}@dsh-configandplugin-sync.local`;
        return {
            GIT_AUTHOR_NAME: authorName,
            GIT_AUTHOR_EMAIL: authorEmail,
            GIT_COMMITTER_NAME: authorName,
            GIT_COMMITTER_EMAIL: authorEmail,
        };
    };
    /** Sanitize the commit subject into one non-empty line. */
    const commitSubject = (message) => {
        const line = redactText(typeof message === 'string' ? message : '')
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return line === '' ? 'DSH 配置同步 / DSH config sync' : line.slice(0, 200);
    };
    /** Modify the tree, commit and push; one attempt of the write loop. */
    const publish = async (request, files, deletions, expectedHead) => {
        const { branch, storePath } = settings();
        await applyWrite(files, deletions, request.signal);
        await runGitOrThrow(['add', '-A'], { cwd: workDir, signal: request.signal });
        const status = await runGitOrThrow(['status', '--porcelain', '-z'], { cwd: workDir, signal: request.signal });
        const touched = parsePorcelainZ(status.stdout)
            .filter(path => storePath === '' || path === storePath || path.startsWith(`${storePath}/`))
            .map(path => (storePath === '' ? path : path.slice(storePath.length + 1)))
            .filter(path => path !== '')
            .sort();
        if (touched.length === 0) {
            return { changed: false, revision: await readHead(request.signal), changedFiles: [] };
        }
        const body = formatCommitTrailers(request.trailers);
        const commitArgs = ['commit', '--no-verify', '-m', commitSubject(request.message)];
        if (body !== '')
            commitArgs.push('-m', body);
        await runGitOrThrow(commitArgs, {
            cwd: workDir,
            env: commitEnvironment(request.trailers),
            signal: request.signal,
        });
        const commit = await readHead(request.signal);
        const push = await runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workDir, signal: request.signal });
        if (push.code === 0) {
            logger.info('store pushed', { branch, changedFiles: touched.length });
            return { changed: true, revision: commit, changedFiles: touched };
        }
        if (!isNonFastForwardPush(push)) {
            throw classifyGitFailure(push.stderr.length > 0 ? push.stderr : push.stdout, push.timedOut);
        }
        // Another commit landed between our fetch and our push. Re-read the remote:
        // only when HEAD still equals what the caller read is re-applying this run's
        // documents safe; otherwise the engine must merge against fresh state.
        await prepareRemoteOnly(request.signal);
        const refreshed = await readHead(request.signal);
        if (expectedHead === null || refreshed !== expectedHead) {
            throw new SyncError('conflict', '远程仓库在本次写入期间被其他设备更新 / the remote repository changed while this write was in flight', { expectedRevision: expectedHead, actualRevision: refreshed });
        }
        throw new SyncError('conflict', '推送到远程仓库时发生并发冲突 / the push was rejected because the remote moved', { expectedRevision: expectedHead, actualRevision: refreshed });
    };
    /** Fetch and hard-reset to the remote branch without echoing the settings. */
    const prepareRemoteOnly = async (signal) => {
        const { branch } = settings();
        const remoteRef = `refs/remotes/origin/${branch}`;
        const fetch = await runGit(['fetch', '--prune', 'origin', `+refs/heads/${branch}:${remoteRef}`], {
            cwd: workDir,
            signal,
        });
        if (fetch.code !== 0) {
            throw classifyGitFailure(fetch.stderr.length > 0 ? fetch.stderr : fetch.stdout, fetch.timedOut);
        }
        await runGitOrThrow(['reset', '--hard', remoteRef], { cwd: workDir, signal });
    };
    /** Authentication label for the connection test; never includes a secret. */
    const authMethod = () => {
        if (config.authMode === 'https-token') {
            const envName = (config.tokenEnvVar ?? '').trim();
            return envName === '' ? 'https-token' : `https-token (${envName})`;
        }
        return config.authMode;
    };
    const read = async (signal) => withWorkDirLock(workDir, async () => {
        await prepare(signal);
        const { root } = settings();
        const head = await readHead(signal);
        const files = new Map();
        const walk = async (directory, prefix) => {
            let entries;
            try {
                entries = await readdir(directory, { withFileTypes: true });
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return;
                rethrowSync(error, 'internal');
            }
            entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
            for (const entry of entries) {
                if (signal?.aborted === true)
                    throw new SyncError('cancelled', '操作已取消 / operation cancelled');
                if (entry.name === '.git')
                    continue;
                const absolute = join(directory, entry.name);
                const storeRelative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
                if (entry.isSymbolicLink()) {
                    logger.warn('skipping a symbolic link in the store', { path: storeRelative });
                    continue;
                }
                if (entry.isDirectory()) {
                    await walk(absolute, storeRelative);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                if (files.size >= MAX_STORE_FILES) {
                    throw new SyncError('invalid-config', `存储文件数量超过上限 ${MAX_STORE_FILES} / the store has more files than the limit (${MAX_STORE_FILES})`);
                }
                const info = await stat(absolute);
                if (info.size > MAX_DOCUMENT_BYTES) {
                    throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${storeRelative}`);
                }
                try {
                    files.set(storeRelative, new Uint8Array(await readFile(absolute)));
                }
                catch (error) {
                    rethrowSync(error, 'internal');
                }
            }
        };
        await walk(root, '');
        return { revision: head, files };
    });
    const write = async (request) => withWorkDirLock(workDir, async () => {
        if (request.signal?.aborted === true)
            throw new SyncError('cancelled', '操作已取消 / operation cancelled');
        const files = normalizeRequestFiles(request.files);
        const deletions = normalizeRequestDeletions(request.deletions);
        const prepared = await prepare(request.signal);
        // `null` is itself a revision ("the store was empty when I read it"), so the
        // comparison is strict: any drift from what the caller read is a conflict.
        if (request.expectedRevision !== prepared.head) {
            throw new SyncError('conflict', '存储已被其他设备更新，请重新读取后再写入 / the store changed since it was read; read it again before writing', { expectedRevision: request.expectedRevision, actualRevision: prepared.head });
        }
        let retried = false;
        let attempt = 0;
        for (;;) {
            if (attempt > 0) {
                await prepareRemoteOnly(request.signal);
                const head = await readHead(request.signal);
                if (request.expectedRevision === null || head !== request.expectedRevision) {
                    throw new SyncError('conflict', '推送到远程仓库时发生并发冲突 / the push was rejected because the remote moved', { expectedRevision: request.expectedRevision, actualRevision: head });
                }
                retried = true;
            }
            try {
                const outcome = await publish(request, files, deletions, prepared.head);
                return {
                    changed: outcome.changed,
                    revision: outcome.revision,
                    changedFiles: outcome.changedFiles,
                    retried,
                };
            }
            catch (error) {
                if (error instanceof SyncError && error.code === 'conflict' && attempt === 0) {
                    // `publish` refreshed the remote and proved HEAD still equals the
                    // revision the caller read: one clean retry is safe.
                    const head = await readHead(request.signal);
                    if (request.expectedRevision !== null && head === request.expectedRevision) {
                        attempt += 1;
                        logger.warn('retrying the store push after a transport race');
                        continue;
                    }
                }
                throw error;
            }
        }
    });
    const history = async (historyOptions = {}) => withWorkDirLock(workDir, async () => {
        await prepare(historyOptions.signal);
        if ((await readHead(historyOptions.signal)) === null)
            return [];
        const requested = historyOptions.limit;
        const limit = requested !== undefined && Number.isFinite(requested)
            ? Math.min(1_000, Math.max(1, Math.trunc(requested)))
            : HISTORY_LIMIT;
        const result = await runGitOrThrow(['log', '-n', String(limit), `--format=${HISTORY_FORMAT}`], {
            cwd: workDir,
            signal: historyOptions.signal,
        });
        return parseHistoryLog(result.stdout);
    });
    const testConnection = async (signal) => {
        const at = new Date().toISOString();
        let revision = null;
        const label = authMethod();
        try {
            const { repoUrl, branch } = settings();
            const result = await runGit(['ls-remote', '--heads', repoUrl, `refs/heads/${branch}`], { signal });
            if (result.code !== 0) {
                const error = classifyGitFailure(result.stderr.length > 0 ? result.stderr : result.stdout, result.timedOut);
                logger.warn('git connection test failed', { code: error.code });
                return { ok: false, at, kind, revision: null, message: redactText(error.message), authMethod: label };
            }
            for (const line of result.stdout.split(/\r?\n/)) {
                const match = /^([0-9a-fA-F]{40,64})\s+refs\/heads\/(.+)$/.exec(line.trim());
                if (match === null || match[2] !== branch)
                    continue;
                revision = match[1] ?? null;
                break;
            }
            logger.info('git connection test succeeded', { branch, hasBranch: revision !== null });
            return {
                ok: true,
                at,
                kind,
                revision,
                message: revision === null
                    ? `已连接仓库，但分支 ${branch} 尚不存在 / connected, but branch ${branch} does not exist yet`
                    : `已连接仓库 / connected; ${branch} @ ${revision.slice(0, 8)}`,
                authMethod: label,
            };
        }
        catch (error) {
            const message = error instanceof SyncError ? error.message : errorMessage(error);
            logger.warn('git connection test failed', { code: error instanceof SyncError ? error.code : 'internal' });
            return { ok: false, at, kind, revision: null, message: redactText(message), authMethod: label };
        }
    };
    return {
        kind,
        destination: describeGitDestination(config, options.storePath ?? ''),
        read,
        write,
        history,
        testConnection,
    };
}
