import { describe, expect, it, vi } from 'vitest'
import type { ServerClient } from './serverClient'
import { serverRoutes } from './serverRoutes'

function routes() {
  const request = vi.fn(async () => ({}))
  return { request, routes: serverRoutes({ request } as unknown as ServerClient) }
}

describe('routes that must not be retried on a rate limit', () => {
  it('SYA-C150 asks once to delete a device', async () => {
    const { request, routes: r } = routes()
    await r.revokeDevice('token', 'dev-2', { 'X-Device-Signature': 'sig' })
    expect(request).toHaveBeenCalledWith(
      'DELETE',
      '/v1/devices/dev-2',
      expect.objectContaining({ retryRateLimited: false }),
    )
  })

  it('SYA-C151 asks once to clean up, bound to the manifest it pushed', async () => {
    const { request, routes: r } = routes()
    await r.gc('token', ['a'], 4)
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/v1/sync/gc',
      expect.objectContaining({ body: { keep: ['a'], ifMatch: 4 }, retryRateLimited: false }),
    )
  })
})
