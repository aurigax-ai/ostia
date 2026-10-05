import type { Capability } from '../shared/capabilities'
import { hasCap, initCaps, setCaps } from './capabilityStore'
import { registerScript, resolveToken } from './idRegistry'

export interface AuthedConn {
  externalId: string
  paneId: string
  workspaceId: string
}

export type ScriptTokenCheck = (token: string) => { id: string; caps: Capability[] } | undefined

let checkScriptToken: ScriptTokenCheck = () => undefined

export function setScriptTokenCheck(check: ScriptTokenCheck): void {
  checkScriptToken = check
}

export function authenticate(hello: { token?: unknown }): AuthedConn | null {
  if (typeof hello?.token !== 'string') return null
  const id = resolveToken(hello.token)
  if (id && id.kind !== 'script') {
    initCaps(id.externalId)
    return { externalId: id.externalId, paneId: id.paneId, workspaceId: id.workspaceId }
  }
  const script = checkScriptToken(hello.token)
  if (!script) return null
  const identity = registerScript(script.id)
  setCaps(identity.externalId, script.caps)
  return { externalId: identity.externalId, paneId: '', workspaceId: '' }
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
