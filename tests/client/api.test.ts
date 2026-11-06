/**
 * Tests for the typed Host client: URL, method, credentials, envelope parsing,
 * transport errors, cancellation, timeout, and the two-phase plan helper.
 *
 * The browser globals are stubbed, so no DOM is needed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  getLogs,
  getStatus,
  planFromError,
  post,
  previewRestore,
  previewSync,
  unlockSecrets,
} from '../../client/src/api'
import { API_PREFIX } from '../../src/http/api-types.js'
import { makePlan } from './fixtures'

/** Recorded `fetch` arguments. */
interface FetchCall {
  url: string
  init: RequestInit
}

/** Build a `Response`-shaped object; only the members the client reads exist. */
function fakeResponse(payload: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => {
      if (payload === undefined) throw new SyntaxError('Unexpected token < in JSON')
      return payload
    },
  } as unknown as Response
}

/** Install a fetch stub that answers with `payload` and records its calls. */
function stubFetch(payload: unknown, calls: FetchCall[] = []): FetchCall[] {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(fakeResponse(payload))
  })
  return calls
}

/** Install a fetch stub whose promise rejects with `error`. */
function stubFailingFetch(error: unknown): void {
  vi.stubGlobal('fetch', () => Promise.reject(error))
}

/** A fetch stub that never settles until its signal aborts. */
function stubAbortableFetch(): void {
  vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === null || signal === undefined) return
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('post', () => {
  it('POSTs the route under API_PREFIX and unwraps the success envelope', async () => {
    const calls = stubFetch({ ok: true, value: { state: 'synced' } })
    const value = await post<{ state: string }>('status', { refresh: true }, { timeoutMs: 0 })

    expect(value).toEqual({ state: 'synced' })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe(`${API_PREFIX}/status`)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.credentials).toBe('include')
    expect(call?.init.cache).toBe('no-store')
    expect(call?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(call?.init.body))).toEqual({ refresh: true })
  })

  it('defaults the body to an empty object', async () => {
    const calls = stubFetch({ ok: true, value: null })
    await post('logs', undefined, { timeoutMs: 0 })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({})
  })

  it('throws the Host error code, message, and details from a failure envelope', async () => {
    stubFetch({
      ok: false,
      error: { code: 'invalid-config', message: '仓库地址无效 / invalid repository URL', details: { field: 'git.repoUrl' } },
    })

    const error = await post('config/save', {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiRequestError)
    const requestError = error as ApiRequestError
    expect(requestError.code).toBe('invalid-config')
    expect(requestError.message).toBe('仓库地址无效 / invalid repository URL')
    expect(requestError.details).toEqual({ field: 'git.repoUrl' })
  })

  it('reports a non-envelope body as bad-response with the HTTP status', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(fakeResponse(undefined, 500, 'Internal Server Error')))
    const error = (await post('status', {}, { timeoutMs: 0 }).catch((caught: unknown) => caught)) as ApiRequestError
    expect(error.code).toBe('bad-response')
    expect(error.message).toBe('HTTP 500 Internal Server Error')
  })

  it('reports an envelope-shaped body without a value as bad-response', async () => {
    stubFetch({ ok: true })
    const error = (await post('status', {}, { timeoutMs: 0 }).catch((caught: unknown) => caught)) as ApiRequestError
    expect(error.code).toBe('bad-response')
  })

  it('reports a transport failure as a network error with its message', async () => {
    stubFailingFetch(new TypeError('Failed to fetch'))
    const error = (await post('status', {}, { timeoutMs: 0 }).catch((caught: unknown) => caught)) as ApiRequestError
    expect(error.code).toBe('network')
    expect(error.message).toBe('Failed to fetch')
  })

  it('refuses to start when the caller signal is already aborted', async () => {
    const calls = stubFetch({ ok: true, value: null })
    const controller = new AbortController()
    controller.abort(new Error('用户取消了 / cancelled by user'))

    const error = (await post('status', {}, { signal: controller.signal, timeoutMs: 0 }).catch(
      (caught: unknown) => caught,
    )) as ApiRequestError
    expect(error.code).toBe('aborted')
    expect(error.message).toBe('用户取消了 / cancelled by user')
    expect(calls).toHaveLength(0)
  })

  it('aborts an in-flight request when the caller signal aborts', async () => {
    stubAbortableFetch()
    const controller = new AbortController()
    const pending = post('status', {}, { signal: controller.signal, timeoutMs: 0 })
    controller.abort(new Error('stop now'))

    const error = (await pending.catch((caught: unknown) => caught)) as ApiRequestError
    expect(error.code).toBe('aborted')
    expect(error.message).toBe('stop now')
  })

  it('reports a timeout when the request outlives timeoutMs', async () => {
    stubAbortableFetch()
    const error = (await post('status', {}, { timeoutMs: 10 }).catch((caught: unknown) => caught)) as ApiRequestError
    expect(error.code).toBe('timeout')
  })
})

describe('typed helpers', () => {
  it('routes every helper to its own route', async () => {
    const calls = stubFetch({ ok: true, value: {} })
    await getStatus()
    await getLogs({ limit: 5 })
    await previewRestore()
    await previewSync()
    await unlockSecrets({ passphrase: 'secret' })

    expect(calls.map(call => call.url)).toEqual([
      `${API_PREFIX}/status`,
      `${API_PREFIX}/logs`,
      `${API_PREFIX}/restore/preview`,
      `${API_PREFIX}/sync/preview`,
      `${API_PREFIX}/secrets/unlock`,
    ])
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ limit: 5 })
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({ passphrase: 'secret' })
  })
})

describe('planFromError', () => {
  const plan = makePlan({ conflicts: [], direction: 'pull' })

  it('returns the plan carried by confirmation-required and conflict-present', () => {
    expect(planFromError(new ApiRequestError('confirmation-required', 'x', { plan }))).toBe(plan)
    expect(planFromError(new ApiRequestError('conflict-present', 'x', { plan }))).toBe(plan)
  })

  it('returns null for other codes, other errors, and malformed details', () => {
    expect(planFromError(new ApiRequestError('network', 'x'))).toBeNull()
    expect(planFromError(new Error('x'))).toBeNull()
    expect(planFromError(null)).toBeNull()
    expect(planFromError(new ApiRequestError('conflict-present', 'x', { plan: { direction: 'push' } }))).toBeNull()
    expect(planFromError(new ApiRequestError('conflict-present', 'x', { other: plan }))).toBeNull()
    expect(planFromError(new ApiRequestError('conflict-present', 'x', undefined))).toBeNull()
  })
})
