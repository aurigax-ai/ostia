import { randomBytes, randomUUID } from 'node:crypto'

export type IdentityKind = 'pane' | 'extension'

export interface PaneIdentity {
  kind: IdentityKind
  externalId: string
  token: string
  windowId: string
  sessionId: string
  paneId: string
  extId?: string
}

const byPane = new Map<string, PaneIdentity>()
const byExtension = new Map<string, PaneIdentity>()
const byExternal = new Map<string, PaneIdentity>()
const byToken = new Map<string, PaneIdentity>()

function mint(): { externalId: string; token: string } {
  return { externalId: randomUUID(), token: randomBytes(32).toString('hex') }
}

function index(identity: PaneIdentity): void {
  byExternal.set(identity.externalId, identity)
  byToken.set(identity.token, identity)
}

function unindex(identity: PaneIdentity): void {
  byExternal.delete(identity.externalId)
  byToken.delete(identity.token)
}

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
  const identity: PaneIdentity = { kind: 'pane', ...mint(), ...input }
  byPane.set(identity.paneId, identity)
  index(identity)
  return identity
}

export function removePane(paneId: string): void {
  const id = byPane.get(paneId)
  if (!id) return
  byPane.delete(id.paneId)
  unindex(id)
}

export function removeWindow(windowId: string): void {
  for (const id of [...byPane.values()]) if (id.windowId === windowId) removePane(id.paneId)
}

export function registerExtension(extId: string): PaneIdentity {
  removeExtension(extId)
  const identity: PaneIdentity = {
    kind: 'extension',
    ...mint(),
    windowId: '',
    sessionId: '',
    paneId: '',
    extId,
  }
  byExtension.set(extId, identity)
  index(identity)
  return identity
}

export function removeExtension(extId: string): void {
  const id = byExtension.get(extId)
  if (!id) return
  byExtension.delete(extId)
  unindex(id)
}

export function getByPaneId(paneId: string): PaneIdentity | undefined {
  return byPane.get(paneId)
}
export function windowOfSession(sessionId: string): string | undefined {
  for (const id of byPane.values()) if (id.sessionId === sessionId) return id.windowId
  return undefined
}
export function resolveExternal(externalId: string): PaneIdentity | undefined {
  return byExternal.get(externalId)
}
export function resolveToken(token: string): PaneIdentity | undefined {
  return byToken.get(token)
}
