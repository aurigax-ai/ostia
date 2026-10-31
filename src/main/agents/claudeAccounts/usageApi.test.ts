import { describe, expect, it } from 'vitest'
import { fetchUsage, parseUsage } from './usageApi'

const RESET = '2026-10-27T15:00:00.000000+00:00'

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  }) as unknown as typeof fetch
  return { calls, request }
}

describe('parseUsage', () => {
  it('takes the session and weekly windows as a percent and a reset time', () => {
    expect(
      parseUsage({
        five_hour: { utilization: 42.4, resets_at: RESET },
        seven_day: { utilization: 18, resets_at: RESET },
        seven_day_opus: null,
      }),
    ).toEqual({
      kind: 'ok',
      session: { percent: 42.4, resetsAt: Date.parse(RESET) },
      weekly: { percent: 18, resetsAt: Date.parse(RESET) },
    })
  })

  it('keeps a window that ran past its cap and drops one without a number or a time', () => {
    const answer = parseUsage({
      five_hour: { utilization: 104, resets_at: RESET },
      seven_day: { utilization: '18', resets_at: RESET },
    })
    expect(answer).toEqual({
      kind: 'ok',
      session: { percent: 104, resetsAt: Date.parse(RESET) },
      weekly: null,
    })
    expect(parseUsage({ five_hour: { utilization: 1, resets_at: 'soon' } })).toEqual({
      kind: 'ok',
      session: null,
      weekly: null,
    })
  })

  it('fails a body with neither window, such as an error envelope', () => {
    expect(parseUsage({ error: { type: 'rate_limit_error' } })).toEqual({ kind: 'failed' })
    expect(parseUsage(null)).toEqual({ kind: 'failed' })
  })
})

describe('fetchUsage', () => {
  it('asks the usage endpoint with the bearer and the OAuth beta header and follows no redirect', async () => {
    const { calls, request } = respond(200, { five_hour: { utilization: 5, resets_at: RESET } })
    expect((await fetchUsage('tok', request)).kind).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.method ?? 'GET').toBe('GET')
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'anthropic-beta': 'oauth-2025-04-20',
    })
  })

  it('reports a rate limit with the wait the server asked for', async () => {
    expect(await fetchUsage('tok', respond(429, {}, { 'retry-after': '120' }).request)).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 120_000,
    })
    expect(await fetchUsage('tok', respond(429, {}).request)).toEqual({
      kind: 'rate-limited',
      retryAfterMs: null,
    })
  })

  it('reports a rejected sign-in, and fails any other answer or a body over the cap', async () => {
    expect(await fetchUsage('tok', respond(401, {}).request)).toEqual({ kind: 'auth' })
    expect(await fetchUsage('tok', respond(403, {}).request)).toEqual({ kind: 'auth' })
    expect(await fetchUsage('tok', respond(500, {}).request)).toEqual({ kind: 'failed' })
    expect(await fetchUsage('tok', respond(200, 'x'.repeat(70_000)).request)).toEqual({
      kind: 'failed',
    })
  })

  it('fails when the request itself fails', async () => {
    const request = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchUsage('tok', request)).toEqual({ kind: 'failed' })
  })
})
