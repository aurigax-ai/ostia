import { describe, expect, it, vi } from 'vitest'
import { createServerClient, ServerError } from './serverClient'

function answer(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
}

function client(fetchFn: typeof fetch, pause = vi.fn(async () => {})) {
  return {
    pause,
    api: createServerClient({ baseUrl: () => 'https://s.example', fetchFn, pause }),
  }
}

describe('the server client', () => {
  it('SSY-C166 reports the server time from the Date header of every answer', async () => {
    const onServerTime = vi.fn()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(answer(200, {}, { Date: 'Wed, 21 Oct 2026 07:28:00 GMT' }))
      .mockResolvedValueOnce(answer(403, { error: 'x' }, { Date: 'Wed, 21 Oct 2026 07:29:00 GMT' }))
      .mockResolvedValueOnce(answer(200, {}))
    const api = createServerClient({
      baseUrl: () => 'https://s.example',
      fetchFn: fetchFn as unknown as typeof fetch,
      onServerTime,
    })
    await api.request('GET', '/v1/a')
    await api.request('GET', '/v1/b').catch(() => {})
    await api.request('GET', '/v1/c')
    expect(onServerTime.mock.calls).toEqual([
      [Date.UTC(2026, 9, 21, 7, 28)],
      [Date.UTC(2026, 9, 21, 7, 29)],
    ])
  })

  it('SVA-C12 sends JSON with the bearer token and parses the answer', async () => {
    const fetchFn = vi.fn(async () => answer(200, { ok: 1 }))
    const { api } = client(fetchFn as unknown as typeof fetch)
    expect(await api.request('POST', '/v1/x', { body: { a: 1 }, token: 't0' })).toEqual({ ok: 1 })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://s.example/v1/x')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer t0',
      'Content-Type': 'application/json',
    })
    expect(init.redirect).toBe('error')
  })

  it('SVA-C13 answers undefined for 204', async () => {
    const { api } = client((async () => answer(204)) as unknown as typeof fetch)
    expect(await api.request('DELETE', '/v1/x')).toBeUndefined()
  })

  it('SVA-C14 maps an error body to ServerError with status and code', async () => {
    const { api } = client((async () =>
      answer(403, { error: 'invalid-invite' })) as unknown as typeof fetch)
    await expect(api.request('POST', '/v1/x')).rejects.toMatchObject({
      status: 403,
      code: 'invalid-invite',
    })
  })

  it('SVA-C15 maps a network failure to status 0 unreachable', async () => {
    const { api } = client((async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    const error = await api.request('GET', '/v1/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServerError)
    expect(error).toMatchObject({ status: 0, code: 'unreachable' })
  })

  it('SVA-C16 waits Retry-After once for a short 429 and retries', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(answer(429, { error: 'rate-limited' }, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(answer(200, { ok: true }))
    const { api, pause } = client(fetchFn as unknown as typeof fetch)
    expect(await api.request('GET', '/v1/x')).toEqual({ ok: true })
    expect(pause).toHaveBeenCalledWith(2000)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('SVA-C17 reports a long or repeated 429 with its Retry-After', async () => {
    const long = client((async () =>
      answer(429, { error: 'rate-limited' }, { 'Retry-After': '60' })) as unknown as typeof fetch)
    await expect(long.api.request('GET', '/v1/x')).rejects.toMatchObject({
      status: 429,
      retryAfter: 60,
    })
    expect(long.pause).not.toHaveBeenCalled()
    const twice = vi.fn(async () => answer(429, { error: 'rate-limited' }, { 'Retry-After': '1' }))
    const repeated = client(twice as unknown as typeof fetch)
    await expect(repeated.api.request('GET', '/v1/x')).rejects.toMatchObject({ status: 429 })
    expect(twice).toHaveBeenCalledTimes(2)
  })

  it('SVA-C18 has no server to ask until an address is set', async () => {
    const api = createServerClient({ baseUrl: () => null })
    await expect(api.request('GET', '/v1/x')).rejects.toMatchObject({ code: 'no-server' })
  })

  it('PSH-C61 sends nothing twice for a request that opted out of the 429 retry, and an empty ping has no content type', async () => {
    const fetchFn = vi.fn(async () =>
      answer(429, { error: 'rate-limited' }, { 'Retry-After': '1' }),
    )
    const { api, pause } = client(fetchFn as unknown as typeof fetch)
    await expect(
      api.request('POST', '/v1/push/h', { token: 't', retryRateLimited: false }),
    ).rejects.toMatchObject({ status: 429, retryAfter: 1 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(pause).not.toHaveBeenCalled()
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBeUndefined()
    expect(init.headers).not.toHaveProperty('Content-Type')
  })
})
