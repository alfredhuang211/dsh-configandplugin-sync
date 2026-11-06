/**
 * Unit tests for the locally implemented AWS Signature Version 4.
 *
 * Two kinds of checks:
 *
 * 1. the published AWS `get-vanilla` conformance vector, which pins the signer
 *    against the specification rather than against our own expectations;
 * 2. a reference signer implemented independently in this file (raw
 *    `node:crypto`, no import from the module under test) to cover the shapes
 *    this plugin actually sends: query parameters, percent-encoded keys, a
 *    request body, session tokens and extra headers.
 */

import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AWS_UNSIGNED_PAYLOAD,
  amzDateString,
  canonicalQueryString,
  canonicalUri,
  sha256Hex,
  signAwsV4,
  uriEncode,
} from '../../src/backends/sigv4.js'

/** RFC 3986 percent-encoding, written independently of the implementation. */
function referenceEncode(value: string, encodeSlash = true): string {
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

/** Reference canonical URI: decode each segment, encode it once. */
function referenceCanonicalUri(pathname: string): string {
  const raw = pathname === '' ? '/' : pathname
  return raw
    .split('/')
    .map(segment => referenceEncode(decodeURIComponent(segment)))
    .join('/')
    .replace(/^([^/])/, '/$1')
}

/** Reference canonical query: sorted encoded name/value pairs. */
function referenceCanonicalQuery(search: string): string {
  const params = new URLSearchParams(search)
  const pairs: Array<[string, string]> = []
  for (const [name, value] of params) pairs.push([referenceEncode(name), referenceEncode(value)])
  pairs.sort(([nameA, valueA], [nameB, valueB]) => {
    if (nameA !== nameB) return nameA < nameB ? -1 : 1
    if (valueA === valueB) return 0
    return valueA < valueB ? -1 : 1
  })
  return pairs.map(([name, value]) => `${name}=${value}`).join('&')
}

interface ReferenceInput {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  includePayloadHashHeader?: boolean
  date: Date
}

/** Independent SigV4 implementation used only as a test oracle. */
function referenceSign(input: ReferenceInput): {
  authorization: string
  canonicalRequest: string
  stringToSign: string
  signature: string
  payloadHash: string
} {
  const url = new URL(input.url)
  const amzDate = input.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const scopeDate = input.date.toISOString().slice(0, 10).replace(/-/g, '')
  const payloadHash = createHash('sha256').update(input.body, 'utf8').digest('hex')
  const allHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase()
    if (key === 'authorization') continue
    allHeaders[key] = value.trim().replace(/\s+/g, ' ')
  }
  allHeaders.host = url.host
  allHeaders['x-amz-date'] = amzDate
  if (input.includePayloadHashHeader !== false) allHeaders['x-amz-content-sha256'] = payloadHash
  if (input.sessionToken !== undefined && input.sessionToken !== '') {
    allHeaders['x-amz-security-token'] = input.sessionToken
  }
  const names = Object.keys(allHeaders).sort()
  const canonicalHeaders = names.map(name => `${name}:${allHeaders[name]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    input.method.toUpperCase(),
    referenceCanonicalUri(url.pathname),
    referenceCanonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const credentialScope = `${scopeDate}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')
  const kDate = createHmac('sha256', `AWS4${input.secretAccessKey}`).update(scopeDate, 'utf8').digest()
  const kRegion = createHmac('sha256', kDate).update(input.region, 'utf8').digest()
  const kService = createHmac('sha256', kRegion).update(input.service, 'utf8').digest()
  const kSigning = createHmac('sha256', kService).update('aws4_request', 'utf8').digest()
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { authorization, canonicalRequest, stringToSign, signature, payloadHash }
}

describe('sigv4 encoding helpers', () => {
  it('percent-encodes according to RFC 3986', () => {
    expect(uriEncode('abc-._~XYZ019')).toBe('abc-._~XYZ019')
    expect(uriEncode('a b')).toBe('a%20b')
    expect(uriEncode("!*'()")).toBe('%21%2A%27%28%29')
    expect(uriEncode('a/b')).toBe('a%2Fb')
    expect(uriEncode('a/b', false)).toBe('a/b')
    expect(uriEncode('中文')).toBe('%E4%B8%AD%E6%96%87')
    expect(uriEncode('plus+sign&=?')).toBe('plus%2Bsign%26%3D%3F')
  })

  it('canonicalizes URIs without double encoding', () => {
    expect(canonicalUri('/a%20b/c')).toBe('/a%20b/c')
    expect(canonicalUri('a b/c')).toBe('/a%20b/c')
    expect(canonicalUri('')).toBe('/')
    expect(canonicalUri('/')).toBe('/')
    // A pre-encoded slash stays inside its segment.
    expect(canonicalUri('/a%2Fb')).toBe('/a%2Fb')
  })

  it('sorts and encodes the canonical query string', () => {
    expect(canonicalQueryString('?b=2&a=1')).toBe('a=1&b=2')
    expect(canonicalQueryString('?Param2=value2&Param1=value1')).toBe('Param1=value1&Param2=value2')
    expect(canonicalQueryString('?prefix=a%2Fb&max-keys=1000')).toBe('max-keys=1000&prefix=a%2Fb')
    expect(canonicalQueryString('')).toBe('')
    // A space arrives encoded as `+`; the canonical form must use %20.
    expect(canonicalQueryString('?q=a+b')).toBe('q=a%20b')
  })

  it('formats the amz date', () => {
    expect(amzDateString(new Date('2015-08-30T12:36:00.000Z'))).toBe('20150830T123600Z')
  })

  it('hashes payloads with SHA-256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('hello')).toBe(createHash('sha256').update('hello').digest('hex'))
  })
})

describe('signAwsV4', () => {
  it('matches the published AWS get-vanilla conformance vector', () => {
    const signed = signAwsV4({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      date: new Date('2015-08-30T12:36:00Z'),
      includePayloadHashHeader: false,
    })
    expect(signed.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
    expect(signed.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' +
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches an independently computed signature for a realistic S3 PUT', () => {
    const url =
      'https://s3.example.com/test-bucket/dsh-config-sync/profiles/desktop/plugins%20copy.json?x-id=PutObject&versionId=3'
    const headers = { 'content-type': 'application/octet-stream', 'x-amz-meta-device': 'laptop-01' }
    const body = '{"hello":"世界"}'
    const date = new Date('2026-01-02T03:04:05.000Z')
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
    const signed = signAwsV4({
      method: 'PUT',
      url,
      headers,
      body,
      region: 'eu-central-1',
      service: 's3',
      credentials,
      date,
    })
    const reference = referenceSign({
      method: 'PUT',
      url,
      headers,
      body,
      region: 'eu-central-1',
      service: 's3',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      date,
    })
    expect(signed.canonicalRequest).toBe(reference.canonicalRequest)
    expect(signed.stringToSign).toBe(reference.stringToSign)
    expect(signed.signature).toBe(reference.signature)
    expect(signed.authorization).toBe(reference.authorization)
    expect(signed.headers['x-amz-content-sha256']).toBe(reference.payloadHash)
    expect(signed.headers.authorization).toBe(reference.authorization)
  })

  it('signs temporary-credential requests with the session token header', () => {
    const url = 'https://s3.example.com/bucket/key.json'
    const date = new Date('2026-05-06T07:08:09.000Z')
    const signed = signAwsV4({
      method: 'DELETE',
      url,
      region: 'us-west-2',
      service: 's3',
      credentials: { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token-value' },
      date,
    })
    const reference = referenceSign({
      method: 'DELETE',
      url,
      headers: {},
      body: '',
      region: 'us-west-2',
      service: 's3',
      accessKeyId: 'ASIAEXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'session-token-value',
      date,
    })
    expect(signed.headers['x-amz-security-token']).toBe('session-token-value')
    expect(signed.signedHeaders).toContain('x-amz-security-token')
    expect(signed.signature).toBe(reference.signature)
  })

  it('accepts a precomputed payload hash', () => {
    const signed = signAwsV4({
      method: 'GET',
      url: 'https://s3.example.com/bucket/key',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'A', secretAccessKey: 'B' },
      date: new Date('2026-01-01T00:00:00Z'),
      payloadHash: AWS_UNSIGNED_PAYLOAD,
    })
    expect(signed.payloadHash).toBe(AWS_UNSIGNED_PAYLOAD)
    expect(signed.headers['x-amz-content-sha256']).toBe(AWS_UNSIGNED_PAYLOAD)
    expect(signed.canonicalRequest.endsWith(`\n${AWS_UNSIGNED_PAYLOAD}`)).toBe(true)
  })

  it('never puts the secret key or session token into the credential scope', () => {
    const signed = signAwsV4({
      method: 'GET',
      url: 'https://s3.example.com/bucket/key',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'super-secret-value', sessionToken: 'tok-123' },
      date: new Date('2026-01-01T00:00:00Z'),
    })
    expect(signed.authorization).not.toContain('super-secret-value')
    expect(signed.authorization).toContain('Credential=AKIDEXAMPLE/')
  })
})
