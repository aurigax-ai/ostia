import { describe, expect, it, vi } from 'vitest'
import { signedIn } from '../../../test/fixtures/server/accountHarness'
import { generateDeviceKeys } from './deviceKeys'
import { DeviceSigner } from './deviceSigner'
import { createServerClient, ServerError } from './serverClient'
import { serverRoutes } from './serverRoutes'

describe('signed requests with a timestamp', () => {
  it('SSY-C130 signs again for the retry after a 401, with a later timestamp', async () => {
    const keys = generateDeviceKeys()
    const signer = new DeviceSigner({ keys: () => keys, deviceId: () => 'dev-1', now: () => 1000 })
    const stamps: string[] = []
    const routes = {
      secretWrap: vi.fn(async (_token: string, _slot: string, headers: Record<string, string>) => {
        stamps.push(headers['X-Device-Timestamp'] ?? '')
        if (stamps.length === 1) throw new ServerError(401, 'unauthorized')
        return { slot: 'passphrase', blob: 'b' }
      }),
    }
    const authed = async <T>(use: (token: string, r: typeof routes) => Promise<T>): Promise<T> => {
      try {
        return await use('t1', routes)
      } catch {
        return use('t2', routes)
      }
    }
    const res = await authed((token, r) =>
      signer.signed('wrapRead', (headers) => r.secretWrap(token, 'passphrase', headers), [
        'passphrase',
      ]),
    )
    expect(res).toMatchObject({ slot: 'passphrase' })
    expect(stamps).toEqual(['1000', '1001'])
  })

  it('SSY-C131 does not resend a signed wrap read or device removal after a 429', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('{"error":"rate-limited"}', { status: 429, headers: { 'Retry-After': '1' } }),
    )
    const client = createServerClient({
      baseUrl: () => 'https://s.example',
      fetchFn: fetchFn as unknown as typeof fetch,
      pause: async () => {},
    })
    const routes = serverRoutes(client)
    await expect(
      routes.secretWrap('t', 'passphrase', { 'X-Device-Signature': 's' }),
    ).rejects.toMatchObject({ status: 429 })
    await expect(
      routes.revokeDevice('t', 'dev-1', { 'X-Device-Signature': 's' }),
    ).rejects.toMatchObject({ status: 429 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('SSY-C167 takes the server clock at sign-in, so a desktop clock ten minutes behind needs no retry', async () => {
    const harness = await signedIn({ signerNow: () => Date.now() - 10 * 60_000 })
    const read = () =>
      harness.account.authed((token, routes) =>
        harness.account
          .signer()
          .signed('wrapRead', (headers) => routes.secretWrap(token, 'passphrase', headers), [
            'passphrase',
          ]),
      )
    await expect(read()).rejects.toMatchObject({ status: 404 })
    await expect(read()).rejects.toMatchObject({ status: 404 })
    expect(
      harness.server.requests.filter((r) => r === 'GET /v1/sync/wraps/passphrase'),
    ).toHaveLength(2)
    await harness.close()
  })

  it('SSY-C170 corrects a clock offset that put stamps in the future, then the next request is accepted', async () => {
    const harness = await signedIn()
    await harness.account.authed(async () => {})
    const signer = harness.account.signer()
    signer.observeServerTime(Date.now() + 10 * 60_000)
    const read = () =>
      harness.account.authed((token, routes) =>
        signer.signed('wrapRead', (headers) => routes.secretWrap(token, 'passphrase', headers), [
          'passphrase',
        ]),
      )
    await expect(read()).rejects.toMatchObject({ status: 404 })
    await expect(read()).rejects.toMatchObject({ status: 404 })
    expect(
      harness.server.requests.filter((r) => r === 'GET /v1/sync/wraps/passphrase'),
    ).toHaveLength(3)
    await harness.close()
  })
})
