import type { SnapshotNode, SnapshotWorkspace, WindowWorkspaceSummary } from '@shared/types'
import type { RestorableWorkspace } from '../layout/snapshot'
import { workspaceHandoff } from '../layout/snapshot'
import { allPanes, findPane, paneIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useLayoutStore } from '../stores/layoutStore'
import { isMovable, liveAgentPanes } from '../stores/persistence'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, nextWorkspaceId, useWorkspacesStore } from '../stores/workspacesStore'
import { confirmMove } from './closeConfirm'
import { setIdNamespace } from './idNamespace'
import { jumpToLatestUnreadIn } from './workspaceActivity'

const REPORT_DEBOUNCE_MS = 100

function snapshotPaneIds(node: SnapshotNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'pane') return [node.id]
  return node.children.flatMap(snapshotPaneIds)
}

function findWorkspace(id: string): Workspace | undefined {
  return useWorkspacesStore.getState().workspaces.find((w) => w.id === id)
}

function handoffOf(workspace: Workspace & RestorableWorkspace): SnapshotWorkspace {
  return workspaceHandoff(
    workspace,
    useLayoutStore.getState().byWorkspace[workspace.id],
    liveAgentPanes(),
  )
}

function closeDropped(workspaceId: string, before: readonly string[], kept: SnapshotWorkspace) {
  const moved = new Set(snapshotPaneIds(kept.root))
  for (const paneId of before) {
    if (!moved.has(paneId)) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-closed', workspaceId, paneId })
    }
  }
}

export async function moveWorkspaceToNewWindow(workspaceId: string): Promise<boolean> {
  const workspace = findWorkspace(workspaceId)
  if (!workspace) return false
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!(await confirmMove(workspace, layout ? allPanes(layout.root) : []))) return false
  const current = findWorkspace(workspaceId)
  if (!current || !isMovable(current)) return false
  const before = layout ? paneIds(layout.root) : []
  const handoff = handoffOf(current)
  if (!(await window.pine.windows.detach(handoff))) return false
  useWorkspacesStore.getState().release(workspaceId)
  closeDropped(workspaceId, before, handoff)
  return true
}

export function canMovePane(workspaceId: string, paneId: string): boolean {
  if (findWorkspace(workspaceId)?.kind === 'scratch') return false
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  return pane !== null && pane.kind !== 'diff' && pane.kind !== 'manager'
}

export async function movePaneToNewWindow(workspaceId: string, paneId: string): Promise<boolean> {
  const workspace = findWorkspace(workspaceId)
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!workspace || !isMovable(workspace) || !pane || !canMovePane(workspaceId, paneId)) {
    return false
  }
  if (!(await confirmMove(workspace, [pane]))) return false
  const current = useLayoutStore.getState().byWorkspace[workspaceId]
  const moving = current ? findPane(current.root, paneId) : null
  if (!moving) return false
  const handoff = workspaceHandoff(
    {
      id: nextWorkspaceId(),
      name: workspace.name,
      kind: workspace.kind,
      workDir: workspace.workDir,
    },
    { root: moving, activePaneId: moving.id },
    liveAgentPanes(),
  )
  if (!(await window.pine.windows.detach(handoff))) return false
  useLayoutStore.getState().releasePane(workspaceId, paneId)
  return true
}

export async function returnToMainWindow(): Promise<boolean> {
  const { workspaces } = useWorkspacesStore.getState()
  const { byWorkspace } = useLayoutStore.getState()
  for (const workspace of workspaces) {
    const layout = byWorkspace[workspace.id]
    if (!(await confirmMove(workspace, layout ? allPanes(layout.root) : []))) return false
  }
  return window.pine.windows.returnToMain(
    useWorkspacesStore.getState().workspaces.filter(isMovable).map(handoffOf),
  )
}

export function adoptWorkspaces(workspaces: SnapshotWorkspace[]): void {
  useUIStore.getState().leaveSettings()
  useWorkspacesStore.getState().adopt(workspaces)
}

export function activateWorkspace(workspaceId: string, jumpToUnread: boolean): void {
  if (!findWorkspace(workspaceId)) return
  useUIStore.getState().leaveSettings()
  if (jumpToUnread && jumpToLatestUnreadIn(workspaceId)) return
  useWorkspacesStore.getState().setActive(workspaceId)
}

export function workspaceSummaries(): WindowWorkspaceSummary[] {
  const { byPane } = useAttentionStore.getState()
  const { byWorkspace } = useLayoutStore.getState()
  return useWorkspacesStore.getState().workspaces.map((w) => {
    const layout = byWorkspace[w.id]
    let unreadAt = 0
    const panes = layout ? allPanes(layout.root) : []
    for (const pane of panes) {
      const attention = byPane[pane.id]
      if (attention?.unread && attention.at > unreadAt) unreadAt = attention.at
    }
    return {
      id: w.id,
      name: w.customName ?? w.name,
      workDir: w.projectDir ?? w.workDir,
      state: w.state,
      unreadAt,
      panes: panes.map((p) => ({ id: p.id, title: p.title })),
    }
  })
}

function randomNamespace(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export async function initWindow(): Promise<void> {
  setIdNamespace(randomNamespace())
  try {
    const info = await window.pine?.windows?.info?.()
    if (info) useWindowsStore.getState().setInfo(info.windowId, info.detached)
  } catch (err) {
    console.error('[windows] window info unavailable', err)
  }
}

export function startWindowSync(): () => void {
  const api = window.pine?.windows
  if (!api) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let reported = ''
  const report = (): void => {
    timer = null
    const summaries = workspaceSummaries()
    const signature = JSON.stringify(summaries)
    if (signature === reported) return
    reported = signature
    api.report(summaries)
  }
  const schedule = (): void => {
    if (!timer) timer = setTimeout(report, REPORT_DEBOUNCE_MS)
  }
  report()
  if (
    useWindowsStore.getState().detached &&
    useWorkspacesStore.getState().workspaces.length === 0
  ) {
    window.pine.window.close()
  }
  const offs = [
    useWorkspacesStore.subscribe(schedule),
    useLayoutStore.subscribe(schedule),
    useAttentionStore.subscribe(schedule),
    useWorkspacesStore.subscribe((s, prev) => {
      const empty = s.workspaces.length === 0 && prev.workspaces.length > 0
      if (empty && useWindowsStore.getState().detached) window.pine.window.close()
    }),
    api.onList((list) => useWindowsStore.getState().setList(list)),
    api.onAdopt(adoptWorkspaces),
    api.onActivateWorkspace(activateWorkspace),
    api.onReturnRequest(() => void returnToMainWindow()),
  ]
  return () => {
    if (timer) clearTimeout(timer)
    for (const off of offs) off()
  }
}
