import { afterEach, describe, expect, it } from 'vitest'
import { type AccountHarness, signedIn } from '../../../test/fixtures/server/accountHarness'
import { ServerError } from './serverClient'

let harness: AccountHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe('the server session', () => {
  it('SVA-C19 signs a challenge for a bearer token and keeps it in memory', async () => {
    harness = await signedIn()
    const session = await harness.session.ensure()
    expect(session.token).not.toBe('')
    expect(harness.session.current()).toEqual(session)
    expect(JSON.stringify(harness.saved())).not.toContain(session.token)
  })

  it('SVA-C20 reuses a fresh token and renews one that is about to expire', async () => {
    let now = Date.now()
    harness = await signedIn({ sessionTtlMs: 600_000, now: () => now })
    const first = await harness.session.ensure()
    expect((await harness.session.ensure()).token).toBe(first.token)
    now += 560_000
    const renewed = await harness.session.ensure()
    expect(renewed.token).not.toBe(first.token)
  })

  it('SVA-C21 shares one renewal between concurrent callers', async () => {
    harness = await signedIn()
    const before = harness.server.challenges
    const tokens = await Promise.all(Array.from({ length: 6 }, () => harness?.session.ensure()))
    expect(new Set(tokens.map((s) => s?.token)).size).toBe(1)
    expect(harness.server.challenges - before).toBe(1)
  })

  it('SVA-C22 renews once on a 401 and retries the call with the new token', async () => {
    harness = await signedIn()
    const first = await harness.session.ensure()
    const seen: string[] = []
    const value = await harness.session.authed(async (token) => {
      seen.push(token)
      if (token === first.token) throw new ServerError(401, 'unauthorized')
      return 'ok'
    })
    expect(value).toBe('ok')
    expect(seen).toHaveLength(2)
    expect(seen[1]).not.toBe(first.token)
  })

  it('SVA-C23 retries a rejected call once and then gives up', async () => {
    harness = await signedIn()
    let calls = 0
    await expect(
      harness.session.authed(async () => {
        calls += 1
        throw new ServerError(401, 'unauthorized')
      }),
    ).rejects.toMatchObject({ status: 401 })
    expect(calls).toBe(2)
  })

  it('SVA-C24 passes other errors through without renewing', async () => {
    harness = await signedIn()
    await harness.session.ensure()
    const challenges = harness.server.challenges
    await expect(
      harness.session.authed(async () => {
        throw new ServerError(500, 'boom')
      }),
    ).rejects.toMatchObject({ status: 500 })
    expect(harness.server.challenges).toBe(challenges)
  })

  it('SVA-C25 needs a signed-in device and ends the session on request', async () => {
    harness = await signedIn()
    const { token } = await harness.session.ensure()
    await harness.session.end()
    expect(harness.session.current()).toBeNull()
    expect(harness.server.sessions.has(token)).toBe(false)
  })
})
