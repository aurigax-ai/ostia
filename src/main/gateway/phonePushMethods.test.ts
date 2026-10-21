import { describe, expect, it, vi } from 'vitest'
import { dispatchGatewayMethod, type GatewayControlDeps } from './controlDispatch'

function depsWith(push: Partial<GatewayControlDeps['push']>): GatewayControlDeps {
  return { push } as unknown as GatewayControlDeps
}

const NOTIFY = ['read', 'notify']

describe('push.ticket, push.register and push.unregister', () => {
  it('PSH-C37 need the notify cap and nothing else', async () => {
    const push = { ticket: vi.fn(), register: vi.fn(), unregister: vi.fn() }
    for (const method of ['push.ticket', 'push.register', 'push.unregister']) {
      expect(await dispatchGatewayMethod(method, {}, ['read', 'respond'], depsWith(push))).toEqual({
        ok: false,
        code: -32003,
        message: 'needs-elevation',
        data: { cap: 'notify' },
      })
    }
    expect(push.ticket).not.toHaveBeenCalled()
    expect(push.register).not.toHaveBeenCalled()
    expect(push.unregister).not.toHaveBeenCalled()
  })

  it('PSH-C38 answers push.ticket with the ticket and its expiry', async () => {
    const ticket = vi.fn().mockResolvedValue({ ok: true, ticket: 'tk', expiresAt: 9 })
    const out = await dispatchGatewayMethod(
      'push.ticket',
      {},
      NOTIFY,
      depsWith({ ticket }),
      'dev_1',
    )
    expect(out).toEqual({ ok: true, result: { ticket: 'tk', expiresAt: 9 } })
    expect(ticket).toHaveBeenCalledWith('dev_1')
  })

  it('PSH-C39 maps a refused ticket to push-off, rate-limited and server-unavailable', async () => {
    const answer = async (error: string) =>
      dispatchGatewayMethod(
        'push.ticket',
        {},
        NOTIFY,
        depsWith({ ticket: vi.fn().mockResolvedValue({ ok: false, error }) }),
      )
    expect(await answer('push-off')).toEqual({ ok: false, code: -32602, message: 'push-off' })
    expect(await answer('rate-limited')).toEqual({
      ok: false,
      code: -32007,
      message: 'rate-limited',
    })
    expect(await answer('server-unavailable')).toEqual({
      ok: false,
      code: -32603,
      message: 'server-unavailable',
    })
  })

  it('PSH-C40 passes push.register its handle and platform and answers ok, push-off or bad-params', async () => {
    const register = vi
      .fn()
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, error: 'push-off' })
      .mockReturnValueOnce({ ok: false, error: 'bad-params' })
    const call = () =>
      dispatchGatewayMethod(
        'push.register',
        { handle: 'h', platform: 'fcm' },
        NOTIFY,
        depsWith({ register }),
        'dev_1',
      )
    expect(await call()).toEqual({ ok: true, result: { ok: true } })
    expect(register).toHaveBeenCalledWith('dev_1', 'h', 'fcm')
    expect(await call()).toEqual({ ok: false, code: -32602, message: 'push-off' })
    expect(await call()).toEqual({ ok: false, code: -32602, message: 'bad-params' })
  })

  it('PSH-C41 answers push.unregister ok', async () => {
    const unregister = vi.fn().mockReturnValue({ ok: true })
    expect(
      await dispatchGatewayMethod('push.unregister', {}, NOTIFY, depsWith({ unregister }), 'dev_1'),
    ).toEqual({ ok: true, result: { ok: true } })
    expect(unregister).toHaveBeenCalledWith('dev_1')
  })
})
