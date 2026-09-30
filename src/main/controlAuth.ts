import type { Capability } from '../shared/capabilities'
import { hasCap, initCaps } from './capabilityStore'
import { resolveToken } from './idRegistry'

export interface AuthedConn {
  externalId: string
  paneId: string
  workspaceId: string
}

export function authenticate(hello: { token?: unknown }): AuthedConn | null {
  if (typeof hello?.token !== 'string') return null
  const id = resolveToken(hello.token)
  if (!id) return null
  initCaps(id.externalId)
  return { externalId: id.externalId, paneId: id.paneId, workspaceId: id.workspaceId }
}

export type CapFilter = (conn: AuthedConn, cap: Capability) => boolean

let capFilter: CapFilter = () => true

export function setCapFilter(filter: CapFilter): void {
  capFilter = filter
}

export function capAllowedHere(conn: AuthedConn, cap: Capability): boolean {
  return capFilter(conn, cap)
}

export function connHasCap(conn: AuthedConn, cap: Capability): boolean {
  return capFilter(conn, cap) && hasCap(conn.externalId, cap)
}
