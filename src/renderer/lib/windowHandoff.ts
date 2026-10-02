import type {
  AttentionState,
  ScreenPoint,
  SnapshotNode,
  SnapshotWorkspace,
  WindowPaneReport,
  WindowWorkspaceReport,
  WorkspaceOrigin,
} from '@shared/types'
import type { RestorableWorkspace } from '../layout/snapshot'
import { restoreSnapshot, workspaceHandoff } from '../layout/snapshot'
import { allPanes, findPane, paneIds, placementOf } from '../layout/tree'
import type { LayoutNode, PaneNode } from '../layout/types'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { isMovable, liveAgentPanes } from '../stores/persistence'
import { useSandboxStore } from '../stores/sandboxStore'
import { focusSurfaceWhenReady } from '../stores/surfaceSlotsStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, nextWorkspaceId, useWorkspacesStore } from '../stores/workspacesStore'
import { confirmMove } from './closeConfirm'
import { setIdNamespace } from './idNamespace'
import { originWorkspaceId, startOriginAgentsSync } from './originAgents'
import { runningAgent } from './paneAgent'
import { receiveReference } from './sendPick'
import { jumpToLatestUnreadIn, revealPane } from './workspaceActivity'

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

function originOf(workspace: Workspace): WorkspaceOrigin {
  const index = useWorkspacesStore.getState().workspaces.findIndex((w) => w.id === workspace.id)
  return {
    workspaceId: workspace.id,
    index: Math.max(0, index),
    ...(workspace.groupId ? { groupId: workspace.groupId } : {}),
  }
}

export async function moveWorkspaceToNewWindow(
  workspaceId: string,
  at?: ScreenPoint,
): Promise<boolean> {
  const workspace = findWorkspace(workspaceId)
  if (!workspace) return false
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!(await confirmMove(workspace, layout ? allPanes(layout.root) : []))) return false
  const current = findWorkspace(workspaceId)
  if (!current || !isMovable(current)) return false
  const before = layout ? paneIds(layout.root) : []
  const handoff = { ...handoffOf(current), origin: current.origin ?? originOf(current) }
  if (!(await window.pine.windows.detach(handoff, at))) return false
  useWorkspacesStore.getState().release(workspaceId)
  closeDropped(workspaceId, before, handoff)
  return true
}

function isOnlyPane(workspaceId: string, paneId: string): boolean {
  const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
  return root?.type === 'pane' && root.id === paneId
}

export function canMovePane(workspaceId: string, paneId: string): boolean {
  if (findWorkspace(workspaceId)?.kind === 'scratch') return false
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (pane === null || pane.kind === 'diff' || pane.kind === 'manager') return false
  return isOnlyPane(workspaceId, paneId) || !useSandboxStore.getState().enabled[workspaceId]
}

function paneHandoff(workspace: Workspace, root: LayoutNode, pane: PaneNode): SnapshotWorkspace {
  const beside = placementOf(root, pane.id)
  return {
    ...workspaceHandoff(
      {
        id: nextWorkspaceId(),
        name: workspace.name,
        kind: workspace.kind === 'manager' ? 'terminal' : workspace.kind,
        workDir: workspace.workDir,
        ...(workspace.projectDir ? { projectDir: workspace.projectDir } : {}),
      },
      { root: pane, activePaneId: pane.id },
      liveAgentPanes(),
    ),
    origin: { ...originOf(workspace), ...(beside ? { beside } : {}) },
  }
}

export async function movePaneToNewWindow(
  workspaceId: string,
  paneId: string,
  at?: ScreenPoint,
): Promise<boolean> {
  if (!canMovePane(workspaceId, paneId)) return false
  if (isOnlyPane(workspaceId, paneId)) return moveWorkspaceToNewWindow(workspaceId, at)
  const workspace = findWorkspace(workspaceId)
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!workspace || !isMovable(workspace) || !pane) return false
  if (!(await confirmMove(workspace, [pane]))) return false
  const current = useLayoutStore.getState().byWorkspace[workspaceId]
  const moving = current ? findPane(current.root, paneId) : null
  const owner = findWorkspace(workspaceId)
  if (!current || !moving || !owner) return false
  if (!(await window.pine.windows.detach(paneHandoff(owner, current.root, moving), at))) {
    return false
  }
  useLayoutStore.getState().releasePane(workspaceId, paneId)
  return true
}

export async function movePaneToDropWindow(workspaceId: string, paneId: string): Promise<boolean> {
  if (!canMovePane(workspaceId, paneId)) return false
  const workspace = findWorkspace(workspaceId)
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!workspace || !pane || !(await confirmMove(workspace, [pane]))) return false
  const owner = findWorkspace(workspaceId)
  const current = useLayoutStore.getState().byWorkspace[workspaceId]
  const moving = current ? findPane(current.root, paneId) : null
  if (!owner || !isMovable(owner) || !current || !moving) return false
  const whole = isOnlyPane(workspaceId, paneId)
  const handoff = whole ? handoffOf(owner) : paneHandoff(owner, current.root, moving)
  if (!(await window.pine.windows.give(handoff))) return false
  if (whole) useWorkspacesStore.getState().release(workspaceId)
  else useLayoutStore.getState().releasePane(workspaceId, paneId)
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

export function rejoinTarget(
  workspace: SnapshotWorkspace,
  localIds: ReadonlySet<string>,
): string | null {
  const home = workspace.origin?.workspaceId
  return home && home !== workspace.id && localIds.has(home) ? home : null
}

function rejoin(workspace: SnapshotWorkspace, home: string): string | null {
  const { layouts } = restoreSnapshot({
    v: 1,
    savedAt: '',
    activeWorkspaceId: null,
    workspaces: [workspace],
    groups: [],
  })
  const layout = layouts[workspace.id]
  if (!layout) return null
  useLayoutStore.getState().graft(home, layout, workspace.origin?.beside)
  useWorkspacesStore.getState().setActive(home)
  window.pine?.lifecycle?.emit?.({ type: 'workspace-closed', workspaceId: workspace.id })
  return layout.activePaneId
}

export function adoptWorkspaces(workspaces: SnapshotWorkspace[]): void {
  useUIStore.getState().showWorkspaces()
  const localIds = new Set(useWorkspacesStore.getState().workspaces.map((w) => w.id))
  const standalone: SnapshotWorkspace[] = []
  let focus: string | null = null
  for (const workspace of workspaces) {
    const home = rejoinTarget(workspace, localIds)
    if (home) focus = rejoin(workspace, home) ?? focus
    else standalone.push(workspace)
  }
  if (standalone.length > 0) {
    useWorkspacesStore.getState().adopt(standalone)
    const active = useWorkspacesStore.getState().activeWorkspaceId
    focus = (active && useLayoutStore.getState().byWorkspace[active]?.activePaneId) || focus
  }
  if (focus) focusPaneWhenReady(focus)
}

function focusPaneWhenReady(paneId: string): void {
  if (revealPane(paneId)) focusSurfaceWhenReady(paneId)
}

export function activateWorkspace(workspaceId: string, jumpToUnread: boolean): void {
  if (!findWorkspace(workspaceId)) return
  useUIStore.getState().showWorkspaces()
  if (jumpToUnread && jumpToLatestUnreadIn(workspaceId)) return
  useWorkspacesStore.getState().setActive(workspaceId)
}

function paneReport(pane: PaneNode, state: AttentionState | undefined): WindowPaneReport {
  const agent = pane.kind === 'terminal' ? runningAgent(pane.id) : null
  if (!agent) return { id: pane.id, title: pane.title }
  return {
    id: pane.id,
    title: pane.title,
    agent,
    state: state ?? 'none',
    ...(pane.cwd ? { cwd: pane.cwd } : {}),
  }
}

export function workspaceSummaries(): WindowWorkspaceReport[] {
  const { byPane } = useAttentionStore.getState()
  const { byWorkspace } = useLayoutStore.getState()
  return useWorkspacesStore.getState().workspaces.map((w) => {
    const layout = byWorkspace[w.id]
    let unreadAt = 0
    const origin = originWorkspaceId(w)
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
      panes: panes.map((p) => paneReport(p, byPane[p.id]?.state)),
      ...(origin ? { origin } : {}),
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
  if (useWindowsStore.getState().detached) {
    const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState()
    if (workspaces.length === 0) window.pine.window.close()
    const paneId = activeWorkspaceId
      ? useLayoutStore.getState().byWorkspace[activeWorkspaceId]?.activePaneId
      : undefined
    if (paneId) focusSurfaceWhenReady(paneId)
  }
  const offs = [
    useWorkspacesStore.subscribe(schedule),
    useLayoutStore.subscribe(schedule),
    useAttentionStore.subscribe(schedule),
    useBlocksStore.subscribe((s, prev) => {
      if (s.running !== prev.running || s.agentBlocks !== prev.agentBlocks) schedule()
    }),
    useWorkspacesStore.subscribe((s, prev) => {
      const empty = s.workspaces.length === 0 && prev.workspaces.length > 0
      if (empty && useWindowsStore.getState().detached) window.pine.window.close()
    }),
    api.onList((list) => useWindowsStore.getState().setList(list)),
    api.onAdopt(adoptWorkspaces),
    api.onActivateWorkspace(activateWorkspace),
    api.onReturnRequest(() => void returnToMainWindow()),
    api.onInsertReference((insert) =>
      api.answerInsertReference(insert.requestId, receiveReference(insert)),
    ),
    startOriginAgentsSync(),
  ]
  return () => {
    if (timer) clearTimeout(timer)
    for (const off of offs) off()
  }
}
