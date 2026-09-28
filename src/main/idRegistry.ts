import { randomBytes, randomUUID } from 'node:crypto'

export interface PaneIdentity {
  externalId: string
  token: string
  windowId: string
  sessionId: string
  paneId: string
}

const byPane = new Map<string, PaneIdentity>()
const byExternal = new Map<string, PaneIdentity>()
const byToken = new Map<string, PaneIdentity>()

export function registerPane(input: {
  windowId: string
  sessionId: string
  paneId: string
}): PaneIdentity {
  const existing = byPane.get(input.paneId)
  if (existing) {
    existing.windowId = input.windowId
    if (input.sessionId) existing.sessionId = input.sessionId
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
export function resolveToken(token: string): PaneIdentity | undefined {
  return byToken.get(token)
}
