import { randomBytes, randomUUID } from 'node:crypto'

export type IdentityKind = 'pane' | 'extension'

export interface PaneIdentity {
  kind: IdentityKind
  externalId: string
  token: string
  windowId: string
  workspaceId: string
  paneId: string
  extId?: string
  manager?: true
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
  workspaceId: string
  paneId: string
}): PaneIdentity {
  const existing = byPane.get(input.paneId)
  if (existing) {
    existing.windowId = input.windowId
    if (input.workspaceId) existing.workspaceId = input.workspaceId
    return existing
  }
  const identity: PaneIdentity = { kind: 'pane', ...mint(), ...input }
  byPane.set(identity.paneId, identity)
  index(identity)
  return identity
}

export function adoptPane(input: {
  windowId: string
  workspaceId: string
  paneId: string
  externalId: string
  token: string
}): PaneIdentity {
  removePane(input.paneId)
  const taken = byExternal.get(input.externalId) ?? byToken.get(input.token)
  if (taken) removePane(taken.paneId)
  const identity: PaneIdentity = { kind: 'pane', ...input }
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

export function panesOwnedBy(paneIds: readonly string[], windowId: string): boolean {
  return paneIds.every((paneId) => {
    const owner = byPane.get(paneId)?.windowId
    return owner === undefined || owner === windowId
  })
}

export function rehomePanes(paneIds: readonly string[], windowId: string): PaneIdentity[] {
  const moved: PaneIdentity[] = []
  for (const paneId of paneIds) {
    const identity = byPane.get(paneId)
    if (!identity) continue
    identity.windowId = windowId
    moved.push(identity)
  }
  return moved
}

export function workspaceHasManager(workspaceId: string): boolean {
  for (const identity of byPane.values()) {
    if (identity.workspaceId === workspaceId && identity.manager) return true
  }
  return false
}

export function rehomeWorkspace(sourceId: string, targetId: string): PaneIdentity[] {
  const moved: PaneIdentity[] = []
  for (const identity of byPane.values()) {
    if (identity.workspaceId !== sourceId) continue
    identity.workspaceId = targetId
    moved.push(identity)
  }
  return moved
}

export function registerExtension(extId: string): PaneIdentity {
  removeExtension(extId)
  const identity: PaneIdentity = {
    kind: 'extension',
    ...mint(),
    windowId: '',
    workspaceId: '',
    paneId: '',
    extId,
  }
  byExtension.set(extId, identity)
  index(identity)
  return identity
}

export function removeExtension(extId: string, externalId?: string): void {
  const id = byExtension.get(extId)
  if (!id || (externalId !== undefined && id.externalId !== externalId)) return
  byExtension.delete(extId)
  unindex(id)
}

export function markManager(paneId: string): PaneIdentity | undefined {
  const identity = byPane.get(paneId)
  if (identity) identity.manager = true
  return identity
}

export function getByPaneId(paneId: string): PaneIdentity | undefined {
  return byPane.get(paneId)
}
export function windowOfWorkspace(workspaceId: string): string | undefined {
  for (const id of byPane.values()) if (id.workspaceId === workspaceId) return id.windowId
  return undefined
}
export function resolveExternal(externalId: string): PaneIdentity | undefined {
  return byExternal.get(externalId)
}
export function resolveToken(token: string): PaneIdentity | undefined {
  return byToken.get(token)
}
