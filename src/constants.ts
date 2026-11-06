/**
 * Static identity and defaults of **DSH 配置与插件同步 / DSH Config & Plugin Sync**.
 * @module constants
 */

/** Cordis plugin name; equals the bundle row id and the npm package name. */
export const PACKAGE_NAME = 'dsh-configandplugin-sync'

/** Chinese product title. */
export const TITLE_ZH = 'DSH 配置与插件同步'

/** English product title. */
export const TITLE_EN = 'DSH Config & Plugin Sync'

/** Directory under the DSH home holding this plugin's private data. */
export const APP_DIR_NAME = 'dsh-configandplugin-sync'

/** Namespace key used by the settings section and the locale dictionaries. */
export const LOCALE_NS = PACKAGE_NAME

/** HTTP API prefix served on the Host connection channel. */
export const API_PREFIX = `/api/${PACKAGE_NAME}`

/** Default directory inside a backend that holds the synchronized documents. */
export const DEFAULT_STORE_PATH = 'dsh-config-sync'

/** Default git branch used when the configuration leaves it empty. */
export const DEFAULT_BRANCH = 'main'

/** Default name of the environment variable holding the secrets passphrase. */
export const DEFAULT_PASSPHRASE_ENV = 'DSH_SYNC_PASSPHRASE'

/** Name of the environment variable that may hold a git HTTPS token. */
export const DEFAULT_TOKEN_ENV = 'DSH_SYNC_TOKEN'

/** Envelope format version of the encrypted secret document. */
export const SECRETS_ENVELOPE_VERSION = 1

/** scrypt cost parameters; N is the CPU/memory cost, r the block size, p the parallelization. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const

/** Length in bytes of the derived AES-256 key. */
export const DERIVED_KEY_BYTES = 32

/** Length in bytes of the AES-GCM initialization vector. */
export const GCM_IV_BYTES = 12

/** Maximum number of files a single store read may return (guards a hostile listing). */
export const MAX_STORE_FILES = 2000

/** Maximum size in bytes of one stored document. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** How many store revisions (git commits / object-store snapshots) the history keeps. */
export const HISTORY_LIMIT = 100

/** Root patch file inside the DSH home. */
export const HOME_PATCH_FILE = 'cordis.patch.yml'

/** Profile patch file, relative to a profile directory. */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'

/** Profile root composition file, relative to a profile directory. */
export const PROFILE_CORDIS_FILE = 'cordis.yml'

/** Profile package manifest, relative to a profile directory. */
export const PROFILE_PACKAGE_FILE = 'package.json'

/** Credential store file inside the DSH home. */
export const CREDENTIALS_FILE = '.credentials.yaml'

/** Loader entry ids this plugin understands as module providers. */
export const LLM_ENTRY_HINT = 'llm'
