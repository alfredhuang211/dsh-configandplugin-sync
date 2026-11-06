/**
 * WebDAV storage backend.
 *
 * The store is one WebDAV collection (plus nested collections for section
 * documents). Everything is driven by four verbs:
 *
 * - `PROPFIND` with `Depth: 1`, walked level by level. `Depth: infinity` is
 *   deliberately never used: many servers (and every reverse proxy worth its
 *   name) reject it, and a level-by-level walk also gives per-collection
 *   failure handling for free.
 * - `GET` for documents,
 * - `PUT` / `DELETE` for writes,
 * - `MKCOL` for the collections a write needs.
 *
 * **Revision model.** Object stores have no commit id, so the revision is a
 * SHA-256 over the sorted `(path, content digest)` pairs of the whole store.
 * It is therefore a pure function of what was read: two devices that see the
 * same documents compute the same revision, and an external writer changes it.
 *
 * **Concurrency.** A write compares the caller's `expectedRevision` with the
 * revision this backend read, and sends `If-Match` with the strong ETag the
 * server reported for each document it replaces (or `If-None-Match: *` for a
 * new document). A `412 Precondition Failed` is surfaced as
 * {@link SyncError} code `conflict`, never retried here: only the engine can
 * merge another device's changes safely.
 *
 * Credentials are sent as an `Authorization` header built from the local
 * configuration; they never appear in a URL, a log line or an error message.
 * @module backends/webdav
 */

import { MAX_DOCUMENT_BYTES, MAX_STORE_FILES } from '../constants.js'
import { SyncError, errorMessage } from '../core/errors.js'
import { sha256Bytes, sha256Text } from '../core/hash.js'
import { normalizeStorePath } from '../core/paths.js'
import { redactText, sanitizeUrl } from '../core/redact.js'
import type {
  BackendKind,
  ConnectionTestResult,
  HistoryEntry,
  StoreSnapshot,
  StoreWriteRequest,
  StoreWriteResult,
  SyncBackend,
  SyncLogger,
  WebdavBackendConfig,
} from '../types.js'
import type { BackendOptions } from './index.js'

/** Per-request timeout in milliseconds. */
export const WEBDAV_TIMEOUT_MS = 60_000

/** Whether a caller signal is already aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** `PROPFIND` request body asking for the properties a walk needs. */
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`

/** One entry discovered by a `PROPFIND` walk. */
interface DavEntry {
  /** Path relative to the store root, `''` for the root collection itself. */
  path: string
  isCollection: boolean
  /** ETag exactly as the server sent it (including quotes), when strong. */
  etag?: string
  size?: number
}

/** What one successful read cached for a later write. */
interface DavCache {
  revision: string | null
  /** Store-relative path → SHA-256 of its bytes. */
  digests: Map<string, string>
  /** Store-relative path → strong ETag, when the server provides one. */
  etags: Map<string, string>
}

/** Decode the five XML entities an HTTP response may contain. */
function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, '&')
}

/** Strip namespace prefixes so the parser does not depend on `D:` vs `d:`. */
function stripXmlPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z0-9_.-]+:/g, '<$1')
}

/** Read the text of the first occurrence of one tag. */
function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match === null ? undefined : decodeXmlText((match[1] ?? '').trim())
}

/** Parse one `multistatus` document into its entries. */
export function parseMultistatus(xml: string): Array<{ href: string; isCollection: boolean; etag?: string; size?: number }> {
  const normalized = stripXmlPrefixes(xml)
  const responses = normalized.match(/<response\b[\s\S]*?<\/response>/gi) ?? []
  const out: Array<{ href: string; isCollection: boolean; etag?: string; size?: number }> = []
  for (const block of responses) {
    const href = xmlTag(block, 'href')
    if (href === undefined || href === '') continue
    const isCollection = /<resourcetype\b[^>]*>[\s\S]*?<collection\b/i.test(block)
    const rawEtag = xmlTag(block, 'getetag')
    const etag = rawEtag === undefined || rawEtag.trim() === '' ? undefined : rawEtag.trim()
    const rawLength = xmlTag(block, 'getcontentlength')
    const parsedLength = rawLength === undefined ? Number.NaN : Number.parseInt(rawLength, 10)
    const size = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : undefined
    out.push({ href, isCollection, ...(etag === undefined ? {} : { etag }), ...(size === undefined ? {} : { size }) })
  }
  return out
}

/** Compute the store revision over a path → content-digest map. */
export function computeWebdavRevision(digests: ReadonlyMap<string, string>): string | null {
  if (digests.size === 0) return null
  const lines = [...digests.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, digest]) => `${path}\u0000${digest}`)
  return `sha256:${sha256Text(lines.join('\n'))}`
}

/**
 * Validate a WebDAV collection URL.
 *
 * @throws {SyncError} `not-configured` when blank, `invalid-config` when not an
 *   http(s) URL or when it embeds credentials.
 */
export function normalizeWebdavUrl(raw: string): URL {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') {
    throw new SyncError('not-configured', '尚未配置 WebDAV 地址 / the WebDAV URL is not configured')
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new SyncError('invalid-config', `WebDAV 地址无效 / invalid WebDAV URL: ${redactText(trimmed)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SyncError('invalid-config', `WebDAV 地址必须是 http(s) / the WebDAV URL must be http(s): ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new SyncError(
      'invalid-config',
      'WebDAV 地址不能内嵌凭据，请使用认证设置 / the WebDAV URL must not embed credentials; use the authentication settings',
    )
  }
  url.search = ''
  url.hash = ''
  return url
}

/**
 * Credential-free destination string for the settings page.
 *
 * Never throws: an incomplete configuration must still render.
 */
export function describeWebdavDestination(
  config: Pick<WebdavBackendConfig, 'url'>,
  storePath = '',
): string {
  const rawUrl = (config.url ?? '').trim()
  const url = rawUrl === '' ? '(未配置 / not configured)' : sanitizeUrl(rawUrl).replace(/\/+$/, '')
  let path = ''
  try {
    path = normalizeStorePath(storePath === '' || storePath === '.' ? '' : storePath)
  } catch {
    path = ''
  }
  return `webdav ${url}${path === '' ? '' : `/${path}`}`
}

/** Percent-encode one raw path segment exactly once. */
function encodeSegment(segment: string): string {
  let raw = segment
  try {
    raw = decodeURIComponent(segment)
  } catch {
    // A segment with a literal `%` stays as-is and gets encoded below.
  }
  return encodeURIComponent(raw)
}

/** Sanitize a store-relative path, rejecting traversal and absolute paths. */
function safeStorePath(path: string): string {
  try {
    return normalizeStorePath(path)
  } catch (error) {
    throw new SyncError('invalid-config', redactText(errorMessage(error)))
  }
}

/**
 * Create the WebDAV storage backend.
 *
 * Configuration is validated on first use, so the plugin can be constructed at
 * startup even when no backend is configured yet.
 */
export function createWebdavBackend(config: WebdavBackendConfig, options: BackendOptions): SyncBackend {
  const logger = options.logger
  const kind: BackendKind = 'webdav'

  /** Validated settings, computed once. */
  interface Settings {
    /** Collection URL from the configuration, always ending in `/`. */
    baseUrl: string
    /** Collection URL of the store root, always ending in `/`. */
    rootUrl: string
    /** Store-relative directory (`''` for the configured collection). */
    storePath: string
    /** Authentication header, or null for an anonymous server. */
    authorization: string | null
    /** Label describing how authentication resolves (never a secret). */
    authMethod: string
  }
  let cachedSettings: Settings | null = null

  const settings = (): Settings => {
    if (cachedSettings !== null) return cachedSettings
    const url = normalizeWebdavUrl(config.url)
    const rawStorePath = (options.storePath ?? '').trim()
    let storePath = ''
    if (rawStorePath !== '' && rawStorePath !== '.') {
      try {
        storePath = normalizeStorePath(rawStorePath)
      } catch (error) {
        throw new SyncError('invalid-config', redactText(errorMessage(error)))
      }
    }
    const base = url.toString().replace(/\/+$/, '')
    const baseUrl = `${base}/`
    const rootUrl = `${base}${storePath === '' ? '' : `/${storePath.split('/').map(encodeSegment).join('/')}`}/`
    const token = (config.token ?? '').trim()
    const username = config.username ?? ''
    const password = config.password ?? ''
    let authorization: string | null = null
    let authMethod = 'none'
    if (token !== '') {
      authorization = `Bearer ${token}`
      authMethod = 'bearer'
    } else if (username !== '' || password !== '') {
      authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
      authMethod = 'basic'
    }
    cachedSettings = { baseUrl, rootUrl, storePath, authorization, authMethod }
    return cachedSettings
  }

  /** Build the URL of a collection (`relativePath === ''` for the store root). */
  const collectionUrl = (relativePath: string): string => {
    const { rootUrl } = settings()
    if (relativePath === '') return rootUrl
    return `${rootUrl}${relativePath.split('/').map(encodeSegment).join('/')}/`
  }

  /** Build the URL of a document. */
  const fileUrl = (relativePath: string): string => {
    const { rootUrl } = settings()
    return `${rootUrl}${relativePath.split('/').map(encodeSegment).join('/')}`
  }

  /** Request headers shared by every call. */
  const baseHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'user-agent': 'dsh-configandplugin-sync',
      accept: 'application/xml, text/xml, */*',
    }
    const { authorization } = settings()
    if (authorization !== null) headers.authorization = authorization
    return headers
  }

  /** Run one HTTP request with timeout and abort handling. */
  const request = async (
    method: string,
    url: string,
    requestOptions: { headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal } = {},
  ): Promise<Response> => {
    const callerSignal = requestOptions.signal
    if (isAborted(callerSignal)) {
      throw new SyncError('cancelled', '操作已取消 / operation cancelled')
    }
    const timeout = AbortSignal.timeout(WEBDAV_TIMEOUT_MS)
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])
    const headers: Record<string, string> = { ...baseHeaders(), ...(requestOptions.headers ?? {}) }
    try {
      return await fetch(url, {
        method,
        headers,
        ...(requestOptions.body === undefined ? {} : { body: requestOptions.body as unknown as NonNullable<RequestInit['body']> }),
        signal,
        redirect: 'follow',
        cache: 'no-store',
      })
    } catch (error) {
      if (isAborted(callerSignal)) {
        throw new SyncError('cancelled', '操作已取消 / operation cancelled')
      }
      const name = (error as { name?: string } | null)?.name
      if (name === 'TimeoutError') {
        throw new SyncError('network', `${method} 请求超时 / ${method} request timed out`)
      }
      throw new SyncError('network', redactText(`${method} 请求失败 / ${method} request failed: ${errorMessage(error)}`))
    }
  }

  /** Map a non-success status to a typed error (no response body is echoed). */
  const statusError = (method: string, status: number, context: string): SyncError => {
    const safeContext = redactText(context)
    if (status === 401) {
      return new SyncError('auth-failed', `WebDAV 认证失败 / WebDAV authentication failed (${method} ${safeContext})`)
    }
    if (status === 403) {
      return new SyncError('auth-failed', `WebDAV 拒绝访问 / WebDAV access denied (${method} ${safeContext})`)
    }
    if (status === 404 || status === 410) {
      return new SyncError('not-found', `WebDAV 资源不存在 / WebDAV resource not found (${method} ${safeContext})`)
    }
    if (status === 412) {
      return new SyncError(
        'conflict',
        `存储已被其他设备修改 / the store was changed by another device (${method} ${safeContext})`,
      )
    }
    if (status === 423) {
      return new SyncError('busy', `WebDAV 资源被锁定 / the WebDAV resource is locked (${method} ${safeContext})`)
    }
    if (status === 507) {
      return new SyncError('internal', `WebDAV 存储空间不足 / the WebDAV server is out of space (${method} ${safeContext})`)
    }
    if (status === 405 || status === 501) {
      return new SyncError('unsupported', `WebDAV 服务器不支持该操作 / unsupported WebDAV operation (${method} ${safeContext})`)
    }
    if (status >= 500) {
      return new SyncError('network', `WebDAV 服务器错误 / WebDAV server error ${status} (${method} ${safeContext})`)
    }
    return new SyncError('internal', `WebDAV 请求失败 / WebDAV request failed ${status} (${method} ${safeContext})`)
  }

  /** Run a `PROPFIND` at the given depth and parse the multistatus body. */
  const propfind = async (url: string, depth: '0' | '1', signal?: AbortSignal): Promise<{
    status: number
    entries: Array<{ href: string; isCollection: boolean; etag?: string; size?: number }>
  }> => {
    const response = await request('PROPFIND', url, {
      headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      signal,
    })
    if (response.status !== 207 && response.status !== 200 && !response.ok) {
      return { status: response.status, entries: [] }
    }
    const text = await response.text()
    return { status: response.status, entries: parseMultistatus(text) }
  }

  /** Convert one `href` into a path relative to the store root, or null when foreign. */
  const hrefToRelative = (href: string): string | null => {
    const { rootUrl } = settings()
    let base: URL
    let target: URL
    try {
      base = new URL(rootUrl)
      target = new URL(href, base)
    } catch {
      return null
    }
    const basePath = base.pathname
    const targetPath = target.pathname
    if (targetPath === basePath || targetPath === basePath.replace(/\/$/, '')) return ''
    const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`
    if (!targetPath.startsWith(prefix)) return null
    const relativeEncoded = targetPath.slice(prefix.length)
    if (relativeEncoded === '') return ''
    let relative: string
    try {
      relative = relativeEncoded
        .split('/')
        .map(segment => decodeURIComponent(segment))
        .join('/')
    } catch {
      return null
    }
    if (relative.includes('..') || relative.includes('\\') || relative.includes('\u0000')) return null
    return relative
  }

  /**
   * Recursively list the store with level-by-level `PROPFIND Depth: 1`.
   *
   * @returns every document and collection, keyed by store-relative path.
   */
  const listStore = async (signal?: AbortSignal): Promise<{ exists: boolean; files: DavEntry[]; collections: DavEntry[] }> => {
    const root = await propfind(collectionUrl(''), '1', signal)
    if (root.status === 404 || root.status === 410) return { exists: false, files: [], collections: [] }
    if (root.status !== 207 && root.status !== 200) throw statusError('PROPFIND', root.status, '/')
    const files: DavEntry[] = []
    const collections: DavEntry[] = []
    const seen = new Set<string>()
    const queue: string[] = []
    const record = (entry: DavEntry): void => {
      if (entry.path === '' || seen.has(entry.path)) return
      seen.add(entry.path)
      if (entry.isCollection) {
        collections.push(entry)
        queue.push(entry.path)
      } else {
        files.push(entry)
      }
    }
    for (const entry of root.entries) {
      const relative = hrefToRelative(entry.href)
      if (relative === null) continue
      record({
        path: relative,
        isCollection: entry.isCollection,
        ...(entry.etag === undefined ? {} : { etag: entry.etag }),
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })
    }
    while (queue.length > 0) {
      if (isAborted(signal)) throw new SyncError('cancelled', '操作已取消 / operation cancelled')
      const directory = queue.shift() ?? ''
      const listing = await propfind(collectionUrl(directory), '1', signal)
      if (listing.status === 404 || listing.status === 410) continue
      if (listing.status !== 207 && listing.status !== 200) {
        throw statusError('PROPFIND', listing.status, directory === '' ? '/' : directory)
      }
      for (const entry of listing.entries) {
        const relative = hrefToRelative(entry.href)
        if (relative === null || relative === directory) continue
        record({
          path: relative,
          isCollection: entry.isCollection,
          ...(entry.etag === undefined ? {} : { etag: entry.etag }),
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })
      }
    }
    return { exists: true, files, collections }
  }

  /** Read one document; null when it disappeared between listing and reading. */
  const getFile = async (path: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
    const response = await request('GET', fileUrl(path), { signal })
    if (response.status === 404 || response.status === 410) return null
    if (!response.ok) throw statusError('GET', response.status, path)
    const declared = response.headers.get('content-length')
    if (declared !== null && /^\d+$/.test(declared) && Number.parseInt(declared, 10) > MAX_DOCUMENT_BYTES) {
      throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`)
    }
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
      throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`)
    }
    return new Uint8Array(buffer)
  }

  /** Create every missing ancestor collection of one document path. */
  const ensureParentCollections = async (path: string, signal?: AbortSignal): Promise<void> => {
    await mkcol('', signal)
    const segments = path.split('/').slice(0, -1)
    for (let index = 1; index <= segments.length; index += 1) {
      await mkcol(segments.slice(0, index).join('/'), signal)
    }
  }

  /** `MKCOL` one collection; an already existing collection is not an error. */
  const mkcol = async (relativePath: string, signal?: AbortSignal): Promise<void> => {
    const response = await request('MKCOL', collectionUrl(relativePath), {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      body: '',
      signal,
    })
    if (response.status === 201 || response.status === 200 || response.status === 204) return
    // 405 Method Not Allowed is the documented "collection already exists".
    if (response.status === 405) return
    if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) return
    if (response.status === 409) {
      throw new SyncError(
        'not-found',
        `WebDAV 父集合不存在，无法创建 ${relativePath === '' ? '/' : relativePath} / the parent collection does not exist`,
      )
    }
    throw statusError('MKCOL', response.status, relativePath === '' ? '/' : relativePath)
  }

  let cache: DavCache | null = null

  const read = async (signal?: AbortSignal): Promise<StoreSnapshot> => {
    const listing = await listStore(signal)
    if (!listing.exists) {
      cache = { revision: null, digests: new Map(), etags: new Map() }
      return { revision: null, files: new Map() }
    }
    if (listing.files.length > MAX_STORE_FILES) {
      throw new SyncError('invalid-config', `存储文件数量超过上限 ${MAX_STORE_FILES} / the store has more files than the limit (${MAX_STORE_FILES})`)
    }
    const files = new Map<string, Uint8Array>()
    const digests = new Map<string, string>()
    const etags = new Map<string, string>()
    for (const entry of listing.files) {
      if (isAborted(signal)) throw new SyncError('cancelled', '操作已取消 / operation cancelled')
      const path = safeStorePath(entry.path)
      if (entry.size !== undefined && entry.size > MAX_DOCUMENT_BYTES) {
        throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`)
      }
      const bytes = await getFile(path, signal)
      if (bytes === null) {
        logger.warn('a store document disappeared while reading', { path })
        continue
      }
      const digest = sha256Bytes(bytes)
      files.set(path, bytes)
      digests.set(path, digest)
      const etag = entry.etag
      if (etag !== undefined && !etag.startsWith('W/')) etags.set(path, etag)
    }
    cache = { revision: computeWebdavRevision(digests), digests, etags }
    logger.info('store read', { documents: files.size, revision: cache.revision })
    return { revision: cache.revision, files }
  }

  /** Normalize the caller's write into safe, unique, size-checked documents. */
  const normalizeFiles = (files: Map<string, Uint8Array>): Array<{ path: string; bytes: Uint8Array; digest: string }> => {
    if (!(files instanceof Map)) {
      throw new SyncError('invalid-config', '待写入文件必须是映射 / files must be a Map')
    }
    if (files.size > MAX_STORE_FILES) {
      throw new SyncError('invalid-config', `文件数量超过上限 ${MAX_STORE_FILES} / too many files (limit ${MAX_STORE_FILES})`)
    }
    const out: Array<{ path: string; bytes: Uint8Array; digest: string }> = []
    const seen = new Set<string>()
    for (const [rawPath, bytes] of files) {
      const path = safeStorePath(rawPath)
      if (seen.has(path)) throw new SyncError('invalid-config', `重复的文件路径 / duplicate store path: ${path}`)
      seen.add(path)
      if (!(bytes instanceof Uint8Array)) {
        throw new SyncError('invalid-config', `文件内容必须是字节 / file content must be bytes: ${path}`)
      }
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new SyncError('invalid-config', `文档超过大小上限 / document exceeds the size limit: ${path}`)
      }
      out.push({ path, bytes, digest: sha256Bytes(bytes) })
    }
    out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return out
  }

  /** Normalize the caller's deletion list. */
  const normalizeDeletions = (deletions: readonly string[]): string[] => {
    if (!Array.isArray(deletions)) {
      throw new SyncError('invalid-config', 'deletions 必须是数组 / deletions must be an array')
    }
    if (deletions.length > MAX_STORE_FILES) {
      throw new SyncError('invalid-config', `删除数量超过上限 ${MAX_STORE_FILES} / too many deletions (limit ${MAX_STORE_FILES})`)
    }
    const out: string[] = []
    const seen = new Set<string>()
    for (const rawPath of deletions) {
      const path = safeStorePath(rawPath)
      if (seen.has(path)) continue
      seen.add(path)
      out.push(path)
    }
    return out
  }

  /** `PUT` one document, creating the collections it needs on the first 404/409. */
  const putFile = async (
    path: string,
    bytes: Uint8Array,
    conditional: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const send = async (): Promise<Response> =>
      await request('PUT', fileUrl(path), {
        headers: { 'content-type': 'application/octet-stream', ...conditional },
        body: bytes,
        signal,
      })
    let response = await send()
    if (response.status === 404 || response.status === 409) {
      await ensureParentCollections(path, signal)
      response = await send()
    }
    if (!response.ok) throw statusError('PUT', response.status, path)
    const etag = response.headers.get('etag')
    if (etag === null || etag.trim() === '' || etag.startsWith('W/')) return undefined
    return etag.trim()
  }

  /** `DELETE` one document; a missing document is a no-op. */
  const deleteFile = async (path: string, conditional: Record<string, string>, signal?: AbortSignal): Promise<void> => {
    const response = await request('DELETE', fileUrl(path), { headers: conditional, signal })
    if (response.status === 404 || response.status === 410) return
    if (!response.ok) throw statusError('DELETE', response.status, path)
  }

  const write = async (request_: StoreWriteRequest): Promise<StoreWriteResult> => {
    if (isAborted(request_.signal)) throw new SyncError('cancelled', '操作已取消 / operation cancelled')
    const files = normalizeFiles(request_.files)
    const deletions = normalizeDeletions(request_.deletions)
    // The caller's revision is authoritative: re-read the store and compare, so
    // a concurrent change is detected even when none of *our* documents changed.
    if (request_.expectedRevision !== null || cache === null) await read(request_.signal)
    const snapshot = cache
    if (snapshot === null) throw new SyncError('internal', '存储状态不可用 / the store state is unavailable')
    if (request_.expectedRevision !== null && request_.expectedRevision !== snapshot.revision) {
      throw new SyncError(
        'conflict',
        '存储已被其他设备更新，请重新读取后再写入 / the store changed since it was read; read it again before writing',
        { expectedRevision: request_.expectedRevision, actualRevision: snapshot.revision },
      )
    }
    const changedFiles: string[] = []
    const digests = new Map(snapshot.digests)
    const etags = new Map(snapshot.etags)
    // Only documents whose bytes actually differ are uploaded: the engine sends
    // the whole document set on every write.
    const pendingWrites = files.filter(file => snapshot.digests.get(file.path) !== file.digest)
    const pendingDeletions = deletions.filter(path => snapshot.digests.has(path) || snapshot.etags.has(path))
    for (const deletion of pendingDeletions) {
      if (isAborted(request_.signal)) throw new SyncError('cancelled', '操作已取消 / operation cancelled')
      const etag = snapshot.etags.get(deletion)
      await deleteFile(deletion, etag === undefined ? {} : { 'if-match': etag }, request_.signal)
      digests.delete(deletion)
      etags.delete(deletion)
      changedFiles.push(deletion)
    }
    for (const file of pendingWrites) {
      if (isAborted(request_.signal)) throw new SyncError('cancelled', '操作已取消 / operation cancelled')
      const etag = snapshot.etags.get(file.path)
      // `If-Match` with the ETag that was read is the actual compare-and-swap;
      // `If-None-Match: *` protects a document that did not exist yet. A server
      // that publishes no strong ETag leaves the write best-effort.
      const conditional: Record<string, string> =
        etag !== undefined
          ? { 'if-match': etag }
          : snapshot.digests.has(file.path)
            ? {}
            : { 'if-none-match': '*' }
      const newEtag = await putFile(file.path, file.bytes, conditional, request_.signal)
      digests.set(file.path, file.digest)
      if (newEtag === undefined) etags.delete(file.path)
      else etags.set(file.path, newEtag)
      changedFiles.push(file.path)
    }
    changedFiles.sort()
    const revision = computeWebdavRevision(digests)
    cache = { revision, digests, etags }
    if (changedFiles.length === 0) {
      logger.debug('store write made no changes')
      return { changed: false, revision, changedFiles: [], retried: false }
    }
    logger.info('store written', { changedFiles: changedFiles.length, revision })
    return { changed: true, revision, changedFiles, retried: false }
  }

  const history = async (_historyOptions: { limit?: number; signal?: AbortSignal } = {}): Promise<HistoryEntry[]> => {
    // WebDAV has no revision history; the engine keeps its own operation log.
    return []
  }

  const testConnection = async (signal?: AbortSignal): Promise<ConnectionTestResult> => {
    const at = new Date().toISOString()
    let label = 'none'
    try {
      const current = settings()
      label = current.authMethod
      const probe = async (url: string): Promise<Response> =>
        await request('PROPFIND', url, {
          headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
          body: PROPFIND_BODY,
          signal,
        })
      let response = await probe(current.rootUrl)
      let storeExists = response.status === 207 || response.status === 200 || response.status === 201
      if (!storeExists && (response.status === 404 || response.status === 410)) {
        // The store directory is created by the first write; a reachable parent
        // means the connection and the credentials are fine.
        const parent = await probe(current.baseUrl)
        if (parent.status === 207 || parent.status === 200 || parent.status === 201) {
          logger.info('webdav connection test succeeded; store collection not created yet', { authMethod: label })
          return {
            ok: true,
            at,
            kind,
            revision: null,
            message: '已连接 WebDAV 服务器，同步目录尚未创建 / connected; the sync collection does not exist yet',
            authMethod: label,
          }
        }
        response = parent
      }
      if (storeExists) {
        logger.info('webdav connection test succeeded', { authMethod: label })
        return {
          ok: true,
          at,
          kind,
          revision: cache?.revision ?? null,
          message: '已连接 WebDAV 存储 / connected to the WebDAV store',
          authMethod: label,
        }
      }
      const error = statusError('PROPFIND', response.status, '/')
      logger.warn('webdav connection test failed', { code: error.code })
      return { ok: false, at, kind, revision: null, message: redactText(error.message), authMethod: label }
    } catch (error) {
      const message = error instanceof SyncError ? error.message : errorMessage(error)
      logger.warn('webdav connection test failed', { code: error instanceof SyncError ? error.code : 'internal' })
      return { ok: false, at, kind, revision: null, message: redactText(message), authMethod: label }
    }
  }

  return {
    kind,
    destination: describeWebdavDestination(config, options.storePath ?? ''),
    read,
    write,
    history,
    testConnection,
  }
}
