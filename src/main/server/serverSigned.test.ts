import { describe, expect, it, vi } from 'vitest'
import { generateDeviceKeys } from './deviceKeys'
import { DeviceSigner } from './deviceSigner'
import { createServerClient, ServerError } from './serverClient'
import { ServerDevices } from './serverDevices'
import { serverRoutes } from './serverRoutes'

describe('signed requests with a timestamp', () => {
  it('SSY-C130 signs again for the retry after a 401, with a later timestamp', async () => {
    const keys = generateDeviceKeys()
    const signer = new DeviceSigner({ keys: () => keys, deviceId: () => 'dev-1', now: () => 1000 })
    const stamps: string[] = []
    const routes = {
      createInvite: vi.fn(async (_token: string, headers: Record<string, string>) => {
        stamps.push(headers['X-Device-Timestamp'] ?? '')
        if (stamps.length === 1) throw new ServerError(401, 'unauthorized')
        return { code: 'c', expiresAt: 1 }
      }),
    }
    const account = {
      signer: () => signer,
      authed: async <T>(use: (token: string, r: typeof routes) => Promise<T>): Promise<T> => {
        try {
          return await use('t1', routes)
        } catch {
          return use('t2', routes)
        }
      },
    }
    const res = await new ServerDevices(account as never).createInvite()
    expect(res).toMatchObject({ ok: true, code: 'c' })
    expect(stamps).toEqual(['1000', '1001'])
  })

  it('SSY-C131 does not resend a signed invite or elevation request after a 429', async () => {
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
    await expect(routes.createInvite('t', { 'X-Device-Signature': 's' })).rejects.toMatchObject({
      status: 429,
    })
    await expect(routes.requestApproval('t', { 'X-Device-Signature': 's' })).rejects.toMatchObject({
      status: 429,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
