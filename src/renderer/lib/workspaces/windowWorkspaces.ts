import type { WindowSummary, WindowWorkspaceSummary } from '@shared/types'

export interface RemoteWorkspace extends WindowWorkspaceSummary {
  windowId: string
}

export interface WorkspaceSlot {
  id: string
  windowId: string | null
}

export function remoteWorkspacesOf(
  list: readonly WindowSummary[],
  windowId: string | null,
): RemoteWorkspace[] {
  return list
    .filter((w) => w.windowId !== windowId)
    .flatMap((w) => w.workspaces.map((ws) => ({ ...ws, windowId: w.windowId })))
}

export function globalWorkspaceOrder(
  list: readonly WindowSummary[],
  windowId: string | null,
  local: readonly string[],
): WorkspaceSlot[] {
  const own = local.map((id) => ({ id, windowId }))
  if (!list.some((w) => w.windowId === windowId)) {
    return [
      ...own,
      ...remoteWorkspacesOf(list, windowId).map((w) => ({ id: w.id, windowId: w.windowId })),
    ]
  }
  return list.flatMap((w) =>
    w.windowId === windowId ? own : w.workspaces.map((ws) => ({ id: ws.id, windowId: w.windowId })),
  )
}

export function latestRemoteUnread(
  list: readonly WindowSummary[],
  windowId: string | null,
  after: number,
): RemoteWorkspace | null {
  let best: RemoteWorkspace | null = null
  for (const w of remoteWorkspacesOf(list, windowId)) {
    if (w.unreadAt > after && (!best || w.unreadAt > best.unreadAt)) best = w
  }
  return best
}
