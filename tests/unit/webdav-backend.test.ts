/**
 * WebDAV backend tests against a small in-process WebDAV server.
 *
 * The server emulates exactly the subset the backend uses (PROPFIND Depth
 * 0/1, GET, PUT, DELETE, MKCOL) with strong ETags, conditional
 * `If-Match`/`If-None-Match` handling and the status codes that matter for the
 * error mapping (401, 404, 409, 412). It is deterministic and never touches the
 * network beyond the loopback interface.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebdavBackend } from '../../src/backends/webdav.js'
import { createBackend, describeBackend } from '../../src/backends/index.js'
import { createNullLogger } from '../../src/core/logger.js'
import { SyncError } from '../../src/core/errors.js'
import type { CommitTrailers, SyncBackend, WebdavBackendConfig } from '../../src/types.js'

/** A document held by the fake server. */
interface DavDocument {
  bytes: Buffer
  etag: string
}

/** Request log kept by the fake server for assertions. */
interface RecordedRequest {
  method: string
  path: string
}

/** Percent-encode one path segment for a `multistatus` href. */
function encodeHrefPath(path: string): string {
  return path
    .split('/')
    .map(segment => (segment === '' ? '' : encodeURIComponent(segment)))
    .join('/')
}

/** Decode a request URL path into collection/document form (no trailing slash). */
function decodePath(pathname: string): string {
  let decoded: string
  try {
    decoded = pathname
      .split('/')
      .map(segment => decodeURIComponent(segment))
      .join('/')
  } catch {
    decoded = pathname
  }
  if (decoded.length > 1 && decoded.endsWith('/')) decoded = decoded.replace(/\/+$/, '')
  return decoded === '' ? '/' : decoded
}

/** Parent collection path of a decoded path. */
function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  if (index <= 0) return '/'
  return path.slice(0, index)
}

/** Escape text for an XML document. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Small in-memory WebDAV server with strong ETags. */
class FakeDavServer {
  readonly collections = new Set<string>(['/dav'])
  readonly documents = new Map<string, DavDocument>()
  readonly requests: RecordedRequest[] = []
  expectedAuthorization: string | null = null
  putCount = 0
  /** Forces the next PUT to answer 412, emulating a precondition race. */
  failNextPutWith412 = false

  private server: Server | null = null
  private origin = ''

  /** Start listening on an ephemeral loopback port. */
  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>(resolve => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind to a port')
    this.origin = `http://127.0.0.1:${address.port}`
    return this.origin
  }

  /** Stop listening and drop every connection. */
  async stop(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /** Place a document directly, as an external device would. */
  seedDocument(collectionPath: string, name: string, content: string): void {
    const path = `${collectionPath}/${name}`.replace(/\/+/g, '/')
    this.collections.add(collectionPath)
    this.documents.set(path, { bytes: Buffer.from(content, 'utf8'), etag: this.etagOf(content) })
  }

  /** Compute the ETag this server would publish for some bytes. */
  etagOf(content: string | Buffer): string {
    return `"${Buffer.from(content).toString('base64url')}"`
  }

  /** Request handling of the emulated server. */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await new Promise<Buffer>(resolve => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', () => resolve(Buffer.concat(chunks)))
    })
    const url = new URL(request.url ?? '/', this.origin === '' ? 'http://127.0.0.1' : this.origin)
    const path = decodePath(url.pathname)
    this.requests.push({ method: request.method ?? '', path })
    if (this.expectedAuthorization !== null && request.headers.authorization !== this.expectedAuthorization) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="dav"' })
      response.end()
      return
    }
    switch (request.method) {
      case 'PROPFIND':
        this.handlePropfind(request, response, path)
        return
      case 'GET':
        this.handleGet(response, path)
        return
      case 'PUT':
        this.handlePut(request, response, path, body)
        return
      case 'DELETE':
        this.handleDelete(request, response, path)
        return
      case 'MKCOL':
        this.handleMkcol(request, response, path)
        return
      default:
        response.writeHead(405)
        response.end()
    }
  }

  /** One `multistatus` response. */
  private writeMultistatus(response: ServerResponse, includes: Array<{ path: string; collection: boolean }>): void {
    const parts: string[] = []
    for (const item of includes) {
      const href = encodeHrefPath(item.path) + (item.collection ? '/' : '')
      const props: string[] = []
      if (item.collection) props.push('<d:resourcetype><d:collection/></d:resourcetype>')
      else {
        props.push('<d:resourcetype/>')
        const document = this.documents.get(item.path)
        if (document !== undefined) {
          props.push(`<d:getcontentlength>${document.bytes.byteLength}</d:getcontentlength>`)
          props.push(`<d:getetag>${xmlEscape(document.etag)}</d:getetag>`)
        }
      }
      parts.push(
        `<d:response><d:href>${xmlEscape(href)}</d:href>` +
          `<d:propstat><d:prop>${props.join('')}</d:prop>` +
          '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      )
    }
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`
    response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
    response.end(xml)
  }

  private handlePropfind(request: IncomingMessage, response: ServerResponse, path: string): void {
    if (!this.collections.has(path)) {
      response.writeHead(404)
      response.end()
      return
    }
    const depth = (request.headers.depth ?? '1').toString()
    const includes: Array<{ path: string; collection: boolean }> = [{ path, collection: true }]
    if (depth !== '0') {
      for (const collection of this.collections) {
        if (collection !== path && parentOf(collection) === path) includes.push({ path: collection, collection: true })
      }
      for (const documentPath of this.documents.keys()) {
        if (parentOf(documentPath) === path) includes.push({ path: documentPath, collection: false })
      }
    }
    this.writeMultistatus(response, includes)
  }

  private handleGet(response: ServerResponse, path: string): void {
    const document = this.documents.get(path)
    if (document === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(document.bytes.byteLength),
      etag: document.etag,
    })
    response.end(document.bytes)
  }

  private handlePut(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    body: Buffer,
  ): void {
    if (this.failNextPutWith412) {
      this.failNextPutWith412 = false
      response.writeHead(412)
      response.end()
      return
    }
    if (!this.collections.has(parentOf(path))) {
      response.writeHead(409)
      response.end()
      return
    }
    const existing = this.documents.get(path)
    const ifMatch = request.headers['if-match']
    if (typeof ifMatch === 'string' && (existing === undefined || existing.etag !== ifMatch)) {
      response.writeHead(412)
      response.end()
      return
    }
    if (request.headers['if-none-match'] === '*' && existing !== undefined) {
      response.writeHead(412)
      response.end()
      return
    }
    const etag = this.etagOf(body)
    this.documents.set(path, { bytes: body, etag })
    this.putCount += 1
    response.writeHead(existing === undefined ? 201 : 204, { etag })
    response.end()
  }

  private handleDelete(request: IncomingMessage, response: ServerResponse, path: string): void {
    const existing = this.documents.get(path)
    if (existing === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    const ifMatch = request.headers['if-match']
    if (typeof ifMatch === 'string' && existing.etag !== ifMatch) {
      response.writeHead(412)
      response.end()
      return
    }
    this.documents.delete(path)
    response.writeHead(204)
    response.end()
  }

  private handleMkcol(request: IncomingMessage, response: ServerResponse, path: string): void {
    void request
    if (this.collections.has(path)) {
      response.writeHead(405)
      response.end()
      return
    }
    if (!this.collections.has(parentOf(path))) {
      response.writeHead(409)
      response.end()
      return
    }
    this.collections.add(path)
    response.writeHead(201)
    response.end()
  }
}

/** Canonical trailers of one write. */
function trailers(overrides: Partial<CommitTrailers> = {}): CommitTrailers {
  return {
    operation: 'backup',
    deviceId: 'device-a',
    deviceName: 'Laptop A',
    profile: 'desktop',
    result: 'ok',
    itemCount: '2',
    ...overrides,
  }
}

describe('webdav backend', () => {
  let server: FakeDavServer
  let origin: string
  let workDir: string
  let backend: SyncBackend
  let config: WebdavBackendConfig

  beforeEach(async () => {
    server = new FakeDavServer()
    origin = await server.start()
    workDir = await mkdtemp(join(tmpdir(), 'dav-backend-'))
    config = {
      kind: 'webdav',
      url: `${origin}/dav`,
      username: 'user',
      password: 'correct horse battery staple',
      token: '',
    }
    server.expectedAuthorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
    backend = createWebdavBackend(config, { workDir, storePath: 'store', logger: createNullLogger() })
  })

  afterEach(async () => {
    await server.stop()
    await rm(workDir, { recursive: true, force: true })
  })

  const writeTwoFiles = async (): Promise<{ revision: string | null; changedFiles: string[] }> => {
    const result = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', new TextEncoder().encode('{"revision":1}')],
        ['profiles/desktop/plugins.json', new TextEncoder().encode('{"plugins":[]}')],
      ]),
      deletions: [],
      message: 'backup',
      trailers: trailers(),
      expectedRevision: null,
    })
    return { revision: result.revision, changedFiles: result.changedFiles }
  }

  it('reports a working connection without exposing credentials', async () => {
    const result = await backend.testConnection()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('webdav')
    expect(result.authMethod).toBe('basic')
    expect(result.message).not.toContain(config.password)
    expect(backend.destination).toContain(`${origin}/dav`)
    expect(backend.destination).toContain('/store')
    expect(backend.destination).not.toContain('correct horse battery staple')
    expect(backend.destination).not.toContain('user:')
  })

  it('treats a missing store collection as an empty store', async () => {
    const snapshot = await backend.read()
    expect(snapshot.revision).toBeNull()
    expect(snapshot.files.size).toBe(0)
  })

  it('creates collections and documents on write and reads them back', async () => {
    const { revision, changedFiles } = await writeTwoFiles()
    expect(changedFiles).toEqual(['manifest.json', 'profiles/desktop/plugins.json'])
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(server.collections.has('/dav/store')).toBe(true)
    expect(server.collections.has('/dav/store/profiles')).toBe(true)
    expect(server.collections.has('/dav/store/profiles/desktop')).toBe(true)

    const snapshot = await backend.read()
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.files.size).toBe(2)
    expect(Buffer.from(snapshot.files.get('manifest.json') ?? new Uint8Array()).toString('utf8')).toBe('{"revision":1}')
    expect(
      Buffer.from(snapshot.files.get('profiles/desktop/plugins.json') ?? new Uint8Array()).toString('utf8'),
    ).toBe('{"plugins":[]}')
  })

  it('skips the upload of unchanged documents', async () => {
    const first = await writeTwoFiles()
    const putsAfterFirst = server.putCount
    expect(putsAfterFirst).toBe(2)

    const second = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', new TextEncoder().encode('{"revision":1}')],
        ['profiles/desktop/plugins.json', new TextEncoder().encode('{"plugins":[]}')],
      ]),
      deletions: [],
      message: 'no-op',
      trailers: trailers(),
      expectedRevision: first.revision,
    })
    expect(second.changed).toBe(false)
    expect(second.changedFiles).toEqual([])
    expect(second.revision).toBe(first.revision)
    expect(server.putCount).toBe(putsAfterFirst)

    const third = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', new TextEncoder().encode('{"revision":2}')],
        ['profiles/desktop/plugins.json', new TextEncoder().encode('{"plugins":[]}')],
      ]),
      deletions: [],
      message: 'only manifest changed',
      trailers: trailers({ itemCount: '1' }),
      expectedRevision: first.revision,
    })
    expect(third.changed).toBe(true)
    expect(third.changedFiles).toEqual(['manifest.json'])
    expect(server.putCount).toBe(putsAfterFirst + 1)
  })

  it('deletes documents and reflects the deletion in the revision', async () => {
    const first = await writeTwoFiles()
    const second = await backend.write({
      files: new Map<string, Uint8Array>([['manifest.json', new TextEncoder().encode('{"revision":1}')]]),
      deletions: ['profiles/desktop/plugins.json'],
      message: 'remove plugin inventory',
      trailers: trailers(),
      expectedRevision: first.revision,
    })
    expect(second.changed).toBe(true)
    expect(second.changedFiles).toEqual(['profiles/desktop/plugins.json'])
    expect(server.documents.has('/dav/store/profiles/desktop/plugins.json')).toBe(false)
    const snapshot = await backend.read()
    expect(snapshot.files.has('profiles/desktop/plugins.json')).toBe(false)
    expect(snapshot.revision).toBe(second.revision)
  })

  it('rejects a write whose expected revision does not match', async () => {
    const first = await writeTwoFiles()
    const putsBefore = server.putCount
    await expect(
      backend.write({
        files: new Map<string, Uint8Array>([['manifest.json', new TextEncoder().encode('{"revision":9}')]]),
        deletions: [],
        message: 'stale',
        trailers: trailers(),
        expectedRevision: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(server.putCount).toBe(putsBefore)
    // The store is untouched and still readable at its original revision.
    const snapshot = await backend.read()
    expect(snapshot.revision).toBe(first.revision)
  })

  it('surfaces a 412 from a concurrent modification as a conflict', async () => {
    const first = await writeTwoFiles()
    // Another device replaces one document between our read and our write.
    server.seedDocument('/dav/store/profiles/desktop', 'plugins.json', '{"plugins":["other-device"]}')
    await expect(
      backend.write({
        files: new Map<string, Uint8Array>([
          ['manifest.json', new TextEncoder().encode('{"revision":1}')],
          ['profiles/desktop/plugins.json', new TextEncoder().encode('{"plugins":[]}')],
        ]),
        deletions: [],
        message: 'stale manifest',
        trailers: trailers(),
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps a 412 precondition failure from the server to a conflict', async () => {
    const first = await writeTwoFiles()
    const snapshot = await backend.read()
    expect(snapshot.revision).toBe(first.revision)
    // The store content is still the revision that was read, but the server
    // rejects the PUT as if another writer had just won the race.
    server.failNextPutWith412 = true
    await expect(
      backend.write({
        files: new Map<string, Uint8Array>([
          ['manifest.json', new TextEncoder().encode('{"revision":7}')],
          ['profiles/desktop/plugins.json', new TextEncoder().encode('{"plugins":[]}')],
        ]),
        deletions: [],
        message: 'raced write',
        trailers: trailers(),
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps a 401 to an authentication failure', async () => {
    const wrongPassword = createWebdavBackend(
      { ...config, password: 'wrong-password' },
      { workDir, storePath: 'store', logger: createNullLogger() },
    )
    const result = await wrongPassword.testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('wrong-password')
    expect(result.message).toMatch(/认证|authentication/i)
  })

  it('uses a bearer token when configured and never exposes it', async () => {
    server.expectedAuthorization = 'Bearer s3cr3t-token-value'
    const tokenBackend = createWebdavBackend(
      { ...config, token: 's3cr3t-token-value' },
      { workDir, storePath: 'store', logger: createNullLogger() },
    )
    const result = await tokenBackend.testConnection()
    expect(result.ok).toBe(true)
    expect(result.authMethod).toBe('bearer')
    expect(tokenBackend.destination).not.toContain('s3cr3t-token-value')
  })

  it('cancels a read when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(backend.read(controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('validates configuration through describeBackend and createBackend', async () => {
    expect(() =>
      describeBackend({ kind: 'webdav', url: '', username: '', password: '', token: '' }),
    ).toThrowError(SyncError)
    expect(() =>
      describeBackend({ kind: 'webdav', url: 'https://user:pass@dav.example.com/dav', username: '', password: '', token: '' }),
    ).toThrowError(SyncError)
    const description = describeBackend(config)
    expect(description.kind).toBe('webdav')
    expect(description.supportsHistory).toBe(false)
    expect(description.destination).not.toContain(config.password)

    const created = createBackend(config, { workDir, storePath: 'store', logger: createNullLogger() })
    expect(created.kind).toBe('webdav')
    expect(await created.testConnection()).toMatchObject({ ok: true, kind: 'webdav' })
  })

  it('reports history as unsupported', async () => {
    expect(await backend.history({ limit: 5 })).toEqual([])
  })
})
