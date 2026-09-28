import type { Capability } from '../shared/capabilities'
import { hasCap, initCaps } from './capabilityStore'
import { resolveToken } from './idRegistry'

export interface AuthedConn {
  externalId: string
  paneId: string
  sessionId: string
}

export function authenticate(hello: { token?: unknown }): AuthedConn | null {
  if (typeof hello?.token !== 'string') return null
  const id = resolveToken(hello.token)
  if (!id) return null
  initCaps(id.externalId)
  return { externalId: id.externalId, paneId: id.paneId, sessionId: id.sessionId }
}

export function connHasCap(conn: AuthedConn, cap: Capability): boolean {
  return hasCap(conn.externalId, cap)
}
