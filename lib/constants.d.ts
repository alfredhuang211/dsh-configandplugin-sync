/**
 * Static identity and defaults of **DSH 配置与插件同步 / DSH Config & Plugin Sync**.
 * @module constants
 */
/** Cordis plugin name; equals the bundle row id and the npm package name. */
export declare const PACKAGE_NAME = "dsh-configandplugin-sync";
/** Chinese product title. */
export declare const TITLE_ZH = "DSH \u914D\u7F6E\u4E0E\u63D2\u4EF6\u540C\u6B65";
/** English product title. */
export declare const TITLE_EN = "DSH Config & Plugin Sync";
/** Directory under the DSH home holding this plugin's private data. */
export declare const APP_DIR_NAME = "dsh-configandplugin-sync";
/** Namespace key used by the settings section and the locale dictionaries. */
export declare const LOCALE_NS = "dsh-configandplugin-sync";
/** HTTP API prefix served on the Host connection channel. */
export declare const API_PREFIX = "/api/dsh-configandplugin-sync";
/** Default directory inside a backend that holds the synchronized documents. */
export declare const DEFAULT_STORE_PATH = "dsh-config-sync";
/** Default git branch used when the configuration leaves it empty. */
export declare const DEFAULT_BRANCH = "main";
/** Default name of the environment variable holding the secrets passphrase. */
export declare const DEFAULT_PASSPHRASE_ENV = "DSH_SYNC_PASSPHRASE";
/** Name of the environment variable that may hold a git HTTPS token. */
export declare const DEFAULT_TOKEN_ENV = "DSH_SYNC_TOKEN";
/** Envelope format version of the encrypted secret document. */
export declare const SECRETS_ENVELOPE_VERSION = 1;
/** scrypt cost parameters; N is the CPU/memory cost, r the block size, p the parallelization. */
export declare const SCRYPT_PARAMS: {
    readonly N: number;
    readonly r: 8;
    readonly p: 1;
};
/** Length in bytes of the derived AES-256 key. */
export declare const DERIVED_KEY_BYTES = 32;
/** Length in bytes of the AES-GCM initialization vector. */
export declare const GCM_IV_BYTES = 12;
/** Maximum number of files a single store read may return (guards a hostile listing). */
export declare const MAX_STORE_FILES = 2000;
/** Maximum size in bytes of one stored document. */
export declare const MAX_DOCUMENT_BYTES: number;
/** How many store revisions (git commits / object-store snapshots) the history keeps. */
export declare const HISTORY_LIMIT = 100;
/** Root patch file inside the DSH home. */
export declare const HOME_PATCH_FILE = "cordis.patch.yml";
/** Profile patch file, relative to a profile directory. */
export declare const PROFILE_PATCH_FILE = "cordis.patch.yml";
/** Profile root composition file, relative to a profile directory. */
export declare const PROFILE_CORDIS_FILE = "cordis.yml";
/** Profile package manifest, relative to a profile directory. */
export declare const PROFILE_PACKAGE_FILE = "package.json";
/** Credential store file inside the DSH home. */
export declare const CREDENTIALS_FILE = ".credentials.yaml";
/** Loader entry ids this plugin understands as module providers. */
export declare const LLM_ENTRY_HINT = "llm";
