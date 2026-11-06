/**
 * S3-compatible backend tests against an in-process, signature-verifying server.
 *
 * The server does not trust the client: it recomputes the SigV4 canonical
 * request from the received method, path, query, headers and body (with a
 * reference implementation written independently in this file) and rejects any
 * mismatch with a `403 SignatureDoesNotMatch`. That makes the test a real check
 * of the signer rather than of the client's own bookkeeping. ListObjectsV2 is
 * emulated with continuation tokens so pagination is exercised offline.
 */

import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createS3Backend, buildS3ObjectUrl } from '../../src/backends/s3.js'
import { createBackend, describeBackend } from '../../src/backends/index.js'
import { createNullLogger } from '../../src/core/logger.js'
import { SyncError } from '../../src/core/errors.js'
import type { CommitTrailers, S3BackendConfig, SyncBackend } from '../../src/types.js'

/** One stored object of the fake bucket. */
interface StoredObject {
  bytes: Buffer
  etag: string
}

/** RFC 3986 encoding, implemented independently of the backend. */
function encode(value: string, encodeSlash = true): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const unreserved =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      char === '-' ||
      char === '.' ||
      char === '_' ||
      char === '~' ||
      (char === '/' && !encodeSlash)
    if (unreserved) out += char
    else {
      for (const byte of Buffer.from(char, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** Reference canonical URI: each segment decoded and encoded exactly once. */
function canonicalUri(pathname: string): string {
  const raw = pathname === '' ? '/' : pathname
  return raw
    .split('/')
    .map(segment => {
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        decoded = segment
      }
      return encode(decoded)
    })
    .join('/')
}

/** Reference canonical query string. */
function canonicalQuery(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const pairs: Array<[string, string]> = []
  for (const [name, value] of params) pairs.push([encode(name), encode(value)])
  pairs.sort(([nameA, valueA], [nameB, valueB]) => {
    if (nameA !== nameB) return nameA < nameB ? -1 : 1
    if (valueA === valueB) return 0
    return valueA < valueB ? -1 : 1
  })
  return pairs.map(([name, value]) => `${name}=${value}`).join('&')
}

/** Escape text for an XML document. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Format an S3 XML error body. */
function errorXml(code: string, message: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>`
  )
}

/** A tiny in-memory S3 whose signatures are verified independently. */
class FakeS3Server {
  readonly bucket = 'test-bucket'
  readonly region = 'us-east-1'
  readonly accessKeyId = 'AKIDEXAMPLE'
  readonly secretAccessKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  readonly objects = new Map<string, StoredObject>()
  readonly signatureFailures: string[] = []
  readonly requests: Array<{ method: string; path: string; query: string }> = []
  /** Objects returned per ListObjectsV2 page, whatever the client asks for. */
  pageSize = 1_000
  /** Answer every request with 403 (authentication failure). */
  denyAll = false
  /** Force the next PUT to answer 412. */
  failNextPutWith412 = false
  putCount = 0
  /** Whether any request carried a session token header. */
  sawSessionToken = false

  private server: Server | null = null
  private origin = ''

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>(resolve => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('s3 stub did not bind to a port')
    this.origin = `http://127.0.0.1:${address.port}`
    return this.origin
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /** Store an object directly, as an external writer would. */
  seed(key: string, content: string): void {
    this.objects.set(key, { bytes: Buffer.from(content, 'utf8'), etag: this.etagOf(Buffer.from(content, 'utf8')) })
  }

  private etagOf(bytes: Buffer): string {
    return `"${createHash('sha1').update(bytes).digest('hex')}"`
  }

  /** Verify the SigV4 signature of one request against an independent reference. */
  private verifySignature(request: IncomingMessage, body: Buffer): boolean {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string') return false
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      )
    if (match === null) return false
    const accessKeyId = match[1] ?? ''
    const scopeDate = match[2] ?? ''
    const region = match[3] ?? ''
    const service = match[4] ?? ''
    const signedHeaders = match[5] ?? ''
    const signature = match[6] ?? ''
    const amzDate = request.headers['x-amz-date']
    if (typeof amzDate !== 'string' || accessKeyId !== this.accessKeyId || region !== this.region) return false
    if (service !== 's3') return false
    if (request.headers['x-amz-security-token'] !== undefined) this.sawSessionToken = true
    const payloadHash = request.headers['x-amz-content-sha256']
    if (typeof payloadHash !== 'string') return false
    if (payloadHash !== createHash('sha256').update(body).digest('hex')) return false
    const rawUrl = request.url ?? '/'
    const queryIndex = rawUrl.indexOf('?')
    const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
    const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex)
    const headerNames = signedHeaders.split(';')
    const canonicalHeaders = headerNames
      .map(name => {
        const value = request.headers[name]
        const text = Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
        return `${name}:${text.trim().replace(/\s+/g, ' ')}\n`
      })
      .join('')
    const canonicalRequest = [
      (request.method ?? 'GET').toUpperCase(),
      canonicalUri(pathname),
      canonicalQuery(search),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${scopeDate}/${region}/${service}/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n')
    const kDate = createHmac('sha256', `AWS4${this.secretAccessKey}`).update(scopeDate, 'utf8').digest()
    const kRegion = createHmac('sha256', kDate).update(region, 'utf8').digest()
    const kService = createHmac('sha256', kRegion).update(service, 'utf8').digest()
    const kSigning = createHmac('sha256', kService).update('aws4_request', 'utf8').digest()
    const expected = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
    return expected === signature
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await new Promise<Buffer>(resolve => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', () => resolve(Buffer.concat(chunks)))
    })
    const rawUrl = request.url ?? '/'
    const queryIndex = rawUrl.indexOf('?')
    const queryString = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1)
    const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
    this.requests.push({ method: request.method ?? '', path, query: queryString })
    if (this.denyAll) {
      response.writeHead(403, { 'content-type': 'application/xml' })
      response.end(errorXml('AccessDenied', 'Access Denied'))
      return
    }
    if (!this.verifySignature(request, body)) {
      const reason = `${request.method ?? ''} ${path}?${queryString}`
      this.signatureFailures.push(reason)
      response.writeHead(403, { 'content-type': 'application/xml' })
      response.end(errorXml('SignatureDoesNotMatch', 'The request signature we calculated does not match'))
      return
    }
    const query = new URLSearchParams(queryString)
    const decodedPath = path
      .split('/')
      .map(segment => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })
      .join('/')
    const segments = decodedPath.replace(/^\/+/, '').split('/')
    const bucket = segments[0] ?? ''
    const key = segments.slice(1).join('/')
    if (bucket !== this.bucket) {
      response.writeHead(404, { 'content-type': 'application/xml' })
      response.end(errorXml('NoSuchBucket', 'The specified bucket does not exist'))
      return
    }
    if (query.get('list-type') === '2') {
      this.handleList(response, query)
      return
    }
    switch (request.method) {
      case 'GET':
        this.handleGet(response, key)
        return
      case 'PUT':
        this.handlePut(request, response, key, body)
        return
      case 'DELETE':
        this.objects.delete(key)
        response.writeHead(204)
        response.end()
        return
      default:
        response.writeHead(405, { 'content-type': 'application/xml' })
        response.end(errorXml('MethodNotAllowed', 'method not allowed'))
    }
  }

  private handleList(response: ServerResponse, query: URLSearchParams): void {
    const prefix = query.get('prefix') ?? ''
    const requestedMax = Number.parseInt(query.get('max-keys') ?? '1000', 10)
    const maxKeys = Math.max(
      1,
      Math.min(Number.isFinite(requestedMax) ? requestedMax : 1_000, this.pageSize, 1_000),
    )
    const token = query.get('continuation-token') ?? ''
    const parsedToken = token === '' ? 0 : Number.parseInt(token, 10)
    const start = Number.isFinite(parsedToken) && parsedToken >= 0 ? parsedToken : 0
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort()
    const page = keys.slice(start, start + maxKeys)
    const truncated = start + page.length < keys.length
    const contents = page
      .map(key => {
        const stored = this.objects.get(key)
        if (stored === undefined) return ''
        return (
          '<Contents>' +
          `<Key>${xmlEscape(key)}</Key>` +
          '<LastModified>2026-01-01T00:00:00.000Z</LastModified>' +
          `<ETag>${xmlEscape(stored.etag)}</ETag>` +
          `<Size>${stored.bytes.byteLength}</Size>` +
          '<StorageClass>STANDARD</StorageClass>' +
          '</Contents>'
        )
      })
      .join('')
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      `<Name>${xmlEscape(this.bucket)}</Name>` +
      `<Prefix>${xmlEscape(prefix)}</Prefix>` +
      `<KeyCount>${page.length}</KeyCount>` +
      `<MaxKeys>${maxKeys}</MaxKeys>` +
      `<IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>` +
      (truncated ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>` : '') +
      contents +
      '</ListBucketResult>'
    response.writeHead(200, { 'content-type': 'application/xml' })
    response.end(xml)
  }

  private handleGet(response: ServerResponse, key: string): void {
    const stored = this.objects.get(key)
    if (stored === undefined) {
      response.writeHead(404, { 'content-type': 'application/xml' })
      response.end(errorXml('NoSuchKey', 'The specified key does not exist'))
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(stored.bytes.byteLength),
      etag: stored.etag,
    })
    response.end(stored.bytes)
  }

  private handlePut(request: IncomingMessage, response: ServerResponse, key: string, body: Buffer): void {
    if (this.failNextPutWith412) {
      this.failNextPutWith412 = false
      response.writeHead(412, { 'content-type': 'application/xml' })
      response.end(errorXml('PreconditionFailed', 'At least one of the preconditions you specified did not hold'))
      return
    }
    const existing = this.objects.get(key)
    const ifMatch = request.headers['if-match']
    if (typeof ifMatch === 'string' && (existing === undefined || existing.etag !== ifMatch)) {
      response.writeHead(412, { 'content-type': 'application/xml' })
      response.end(errorXml('PreconditionFailed', 'At least one of the preconditions you specified did not hold'))
      return
    }
    if (request.headers['if-none-match'] === '*' && existing !== undefined) {
      response.writeHead(412, { 'content-type': 'application/xml' })
      response.end(errorXml('PreconditionFailed', 'At least one of the preconditions you specified did not hold'))
      return
    }
    const etag = this.etagOf(body)
    this.objects.set(key, { bytes: body, etag })
    this.putCount += 1
    response.writeHead(200, { etag })
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

/** Encode text as UTF-8 bytes. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('s3 backend', () => {
  let server: FakeS3Server
  let origin: string
  let workDir: string
  let backend: SyncBackend
  let config: S3BackendConfig

  beforeEach(async () => {
    server = new FakeS3Server()
    origin = await server.start()
    workDir = await mkdtemp(join(tmpdir(), 's3-backend-'))
    config = {
      kind: 's3',
      endpoint: origin,
      region: 'us-east-1',
      bucket: server.bucket,
      prefix: 'base/',
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      sessionToken: '',
      forcePathStyle: true,
    }
    backend = createS3Backend(config, { workDir, storePath: 'store', logger: createNullLogger() })
  })

  afterEach(async () => {
    await server.stop()
    await rm(workDir, { recursive: true, force: true })
  })

  const writeTwoFiles = async (): Promise<{ revision: string | null; changedFiles: string[] }> => {
    const result = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', utf8('{"revision":1}')],
        ['profiles/desktop/plugins.json', utf8('{"plugins":[]}')],
      ]),
      deletions: [],
      message: 'backup',
      trailers: trailers(),
      expectedRevision: null,
    })
    return { revision: result.revision, changedFiles: result.changedFiles }
  }

  it('verifies every request signature and reports a working connection', async () => {
    const result = await backend.testConnection()
    expect(server.signatureFailures).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('s3')
    expect(result.authMethod).toBe('access-key')
    expect(result.message).not.toContain(server.secretAccessKey)
    expect(backend.destination).toContain(server.bucket)
    expect(backend.destination).toContain('base/store')
    expect(backend.destination).not.toContain(server.secretAccessKey)
  })

  it('reads an empty store as revision null', async () => {
    const snapshot = await backend.read()
    expect(server.signatureFailures).toEqual([])
    expect(snapshot.revision).toBeNull()
    expect(snapshot.files.size).toBe(0)
  })

  it('writes and reads documents back, keeping a clean prefix', async () => {
    const { revision, changedFiles } = await writeTwoFiles()
    expect(server.signatureFailures).toEqual([])
    expect(changedFiles).toEqual(['manifest.json', 'profiles/desktop/plugins.json'])
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/)
    for (const key of server.objects.keys()) {
      expect(key.startsWith('base/store/')).toBe(true)
      expect(key.includes('//')).toBe(false)
    }

    const snapshot = await backend.read()
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.files.size).toBe(2)
    expect(Buffer.from(snapshot.files.get('manifest.json') ?? new Uint8Array()).toString('utf8')).toBe('{"revision":1}')
  })

  it('skips unchanged objects', async () => {
    const first = await writeTwoFiles()
    const putsAfterFirst = server.putCount
    const second = await backend.write({
      files: new Map<string, Uint8Array>([
        ['manifest.json', utf8('{"revision":1}')],
        ['profiles/desktop/plugins.json', utf8('{"plugins":[]}')],
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
  })

  it('follows ListObjectsV2 continuation tokens', async () => {
    server.pageSize = 2
    const files = new Map<string, Uint8Array>()
    for (let index = 0; index < 5; index += 1) files.set(`docs/doc-${index}.json`, utf8(`{"index":${index}}`))
    const result = await backend.write({
      files,
      deletions: [],
      message: 'five documents',
      trailers: trailers({ itemCount: '5' }),
      expectedRevision: null,
    })
    expect(result.changedFiles).toHaveLength(5)
    const snapshot = await backend.read()
    expect(server.signatureFailures).toEqual([])
    expect(snapshot.files.size).toBe(5)
    expect(snapshot.revision).toBe(result.revision)
    expect([...snapshot.files.keys()]).toEqual([...files.keys()].sort())
  })

  it('deletes objects', async () => {
    const first = await writeTwoFiles()
    const second = await backend.write({
      files: new Map<string, Uint8Array>([['manifest.json', utf8('{"revision":1}')]]),
      deletions: ['profiles/desktop/plugins.json'],
      message: 'remove inventory',
      trailers: trailers(),
      expectedRevision: first.revision,
    })
    expect(second.changed).toBe(true)
    expect(second.changedFiles).toEqual(['profiles/desktop/plugins.json'])
    expect(server.objects.has('base/store/profiles/desktop/plugins.json')).toBe(false)
    expect((await backend.read()).revision).toBe(second.revision)
  })

  it('rejects a write whose expected revision does not match', async () => {
    const first = await writeTwoFiles()
    const putsBefore = server.putCount
    await expect(
      backend.write({
        files: new Map<string, Uint8Array>([['manifest.json', utf8('{"revision":9}')]]),
        deletions: [],
        message: 'stale',
        trailers: trailers(),
        expectedRevision: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(server.putCount).toBe(putsBefore)
    expect((await backend.read()).revision).toBe(first.revision)
  })

  it('detects a document another device changed and reports a conflict', async () => {
    const first = await writeTwoFiles()
    server.seed('base/store/profiles/desktop/plugins.json', '{"plugins":["other-device"]}')
    await expect(
      backend.write({
        files: new Map<string, Uint8Array>([
          ['manifest.json', utf8('{"revision":1}')],
          ['profiles/desktop/plugins.json', utf8('{"plugins":[]}')],
        ]),
        deletions: [],
        message: 'stale manifest',
        trailers: trailers(),
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps a 412 precondition failure to a conflict', async () => {
    const first = await writeTwoFiles()
    server.failNextPutWith412 = true
    await expect(
      backend.write({
        files: new Map<string, Uint8Array>([
          ['manifest.json', utf8('{"revision":7}')],
          ['profiles/desktop/plugins.json', utf8('{"plugins":[]}')],
        ]),
        deletions: [],
        message: 'raced write',
        trailers: trailers(),
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps a 403 to an authentication failure without leaking the secret', async () => {
    server.denyAll = true
    const result = await backend.testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(server.secretAccessKey)
    expect(result.message).toMatch(/认证|authentication/i)
  })

  it('signs with a session token when one is configured', async () => {
    const tokenBackend = createS3Backend(
      { ...config, sessionToken: 'session-token-value' },
      { workDir, storePath: 'store', logger: createNullLogger() },
    )
    const snapshot = await tokenBackend.read()
    expect(server.signatureFailures).toEqual([])
    expect(server.sawSessionToken).toBe(true)
    expect(snapshot.revision).toBeNull()
    expect(tokenBackend.destination).not.toContain('session-token-value')
  })

  it('cancels a read when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(backend.read(controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('builds path-style and virtual-host URLs without double slashes', () => {
    expect(
      buildS3ObjectUrl({
        endpoint: 'https://s3.example.com/',
        bucket: 'my-bucket',
        key: 'a/b c.json',
        forcePathStyle: true,
      }).toString(),
    ).toBe('https://s3.example.com/my-bucket/a/b%20c.json')
    expect(
      buildS3ObjectUrl({
        endpoint: 'https://s3.example.com',
        bucket: 'my-bucket',
        key: '/a//b.json',
        forcePathStyle: true,
      }).toString(),
    ).toBe('https://s3.example.com/my-bucket/a/b.json')
    expect(
      buildS3ObjectUrl({
        endpoint: 'https://s3.example.com/base/',
        bucket: 'my-bucket',
        key: 'a.json',
        forcePathStyle: false,
      }).toString(),
    ).toBe('https://my-bucket.s3.example.com/base/a.json')
    expect(
      buildS3ObjectUrl({
        endpoint: 'https://s3.example.com',
        bucket: 'my-bucket',
        key: '',
        forcePathStyle: true,
      }).toString(),
    ).toBe('https://s3.example.com/my-bucket')
  })

  it('validates configuration and creates through the factory', async () => {
    expect(() =>
      describeBackend({ ...config, endpoint: '', accessKeyId: '', secretAccessKey: '' }),
    ).toThrowError(SyncError)
    expect(() =>
      describeBackend({ ...config, endpoint: 'https://user:pass@s3.example.com' }),
    ).toThrowError(SyncError)
    expect(() => describeBackend({ ...config, secretAccessKey: '' })).toThrowError(SyncError)
    const description = describeBackend(config)
    expect(description.kind).toBe('s3')
    expect(description.supportsHistory).toBe(false)
    expect(description.destination).not.toContain(server.secretAccessKey)

    const created = createBackend(config, { workDir, storePath: 'store', logger: createNullLogger() })
    expect(created.kind).toBe('s3')
    expect(await created.testConnection()).toMatchObject({ ok: true, kind: 's3' })
  })
})
