import type { RpcOutcome } from '../controlDispatch'
import type { PhonePush } from './phonePush'

export interface PhonePushMethodDeps {
  push: Pick<PhonePush, 'ticket' | 'register' | 'unregister' | 'hello'>
}

const PUSH_OFF: RpcOutcome = { ok: false, code: -32602, message: 'push-off' }

export async function pushTicket(deviceId: string, deps: PhonePushMethodDeps): Promise<RpcOutcome> {
  const minted = await deps.push.ticket(deviceId)
  if (minted.ok) {
    return { ok: true, result: { ticket: minted.ticket, expiresAt: minted.expiresAt } }
  }
  if (minted.error === 'push-off') return PUSH_OFF
  if (minted.error === 'rate-limited') return { ok: false, code: -32007, message: 'rate-limited' }
  return { ok: false, code: -32603, message: 'server-unavailable' }
}

export function pushRegister(
  deviceId: string,
  p: Record<string, unknown>,
  deps: PhonePushMethodDeps,
): RpcOutcome {
  const registered = deps.push.register(deviceId, p.handle, p.platform)
  if (registered.ok) return { ok: true, result: { ok: true } }
  return registered.error === 'push-off'
    ? PUSH_OFF
    : { ok: false, code: -32602, message: 'bad-params' }
}

export function pushUnregister(deviceId: string, deps: PhonePushMethodDeps): RpcOutcome {
  return { ok: true, result: deps.push.unregister(deviceId) }
}
