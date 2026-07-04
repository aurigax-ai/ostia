/**
 * Durable external identity for every pane: `externalId ⇄ {windowId, sessionId, paneId}`
 * plus an unguessable per-pane `token`. Populated by renderer→main lifecycle events
 * (`lifecycle:event`) and consulted when spawning a pane's pty (`PINE_*` env) and by the
 * Slice 4 control-socket `hello` handshake. Pure module — no Electron import — so it can
 * be unit-tested in a plain node env (deferred; see Task #22).
 */
import { randomBytes, randomUUID } from 'node:crypto'

export interface PaneIdentity {
  externalId: string
  token: string
  windowId: string
  sessionId: string
  paneId: string
}

const byPane = new Map<string, PaneIdentity>() // key: paneId (globally unique per run)
const byExternal = new Map<string, PaneIdentity>()
const byToken = new Map<string, PaneIdentity>()

/** Mint (or return existing) identity for a pane. Idempotent per paneId. */
export function registerPane(input: {
  windowId: string
  sessionId: string
  paneId: string
}): PaneIdentity {
  const existing = byPane.get(input.paneId)
  if (existing) {
    existing.windowId = input.windowId
    existing.sessionId = input.sessionId
    return existing
  }
  const identity: PaneIdentity = {
    externalId: randomUUID(),
    token: randomBytes(32).toString('hex'),
    ...input,
  }
  byPane.set(identity.paneId, identity)
  byExternal.set(identity.externalId, identity)
  byToken.set(identity.token, identity)
  return identity
}

export function updatePane(
  paneId: string,
  patch: Partial<Pick<PaneIdentity, 'windowId' | 'sessionId'>>,
): void {
  const id = byPane.get(paneId)
  if (id) Object.assign(id, patch)
}

export function removePane(paneId: string): void {
  const id = byPane.get(paneId)
  if (!id) return
  byPane.delete(id.paneId)
  byExternal.delete(id.externalId)
  byToken.delete(id.token)
}

export function removeWindow(windowId: string): void {
  for (const id of [...byPane.values()]) if (id.windowId === windowId) removePane(id.paneId)
}

export function getByPaneId(paneId: string): PaneIdentity | undefined {
  return byPane.get(paneId)
}
export function resolveExternal(externalId: string): PaneIdentity | undefined {
  return byExternal.get(externalId)
}
/** For the Slice 4 control-socket `hello` handshake. */
export function resolveToken(token: string): PaneIdentity | undefined {
  return byToken.get(token)
}
