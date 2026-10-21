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

  it('SYA-C151 asks once to clean up, with the manifest version in If-Match and the signed headers', async () => {
    const { request, routes: r } = routes()
    await r.gc('token', '{"keep":["a"]}', '4', { 'X-Device-Signature': 'sig' })
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/v1/sync/gc',
      expect.objectContaining({
        json: '{"keep":["a"]}',
        headers: { 'If-Match': '4', 'X-Device-Signature': 'sig' },
        retryRateLimited: false,
      }),
    )
  })
})
