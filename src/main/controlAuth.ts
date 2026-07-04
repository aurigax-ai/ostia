/**
 * Token-auth broker for the Slice 4 control socket (spec §6). Verifies the
 * `hello` handshake's `paneToken` against Slice 3's `idRegistry` bijection,
 * seeds default capabilities, and exposes a capability check for the
 * dispatch layer (`controlServer`, Task 3). Pure-ish — depends only on
 * `idRegistry` + `capabilityStore`, no Electron import.
 */
import type { Capability } from '../shared/capabilities'
import { hasCap, initCaps } from './capabilityStore'
import { resolveToken } from './idRegistry'

export interface AuthedConn {
  externalId: string
  paneId: string
  sessionId: string
}

/** Verify a hello token → an authenticated connection identity (or null). Seeds default caps. */
export function authenticate(hello: { token?: unknown }): AuthedConn | null {
  if (typeof hello?.token !== 'string') return null
  const id = resolveToken(hello.token)
  if (!id) return null
  initCaps(id.externalId)
  return { externalId: id.externalId, paneId: id.paneId, sessionId: id.sessionId }
}

/** Broker check: does the connection hold `cap`? */
export function connHasCap(conn: AuthedConn, cap: Capability): boolean {
  return hasCap(conn.externalId, cap)
}
