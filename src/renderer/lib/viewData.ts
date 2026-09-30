import type { ExtensionSidebarItem } from '@shared/extensions'
import type { NotificationEntry } from '@shared/types'
import type { ViewSource } from '@shared/views'
import { allPanes } from '../layout/tree'
import type { WorkspaceLayout } from '../stores/layoutStore'
import type { Workspace } from '../stores/workspacesStore'
import { EMPTY_ATTENTION, type PaneAttention, unreadCount } from './attention'

export const VIEW_NOTIFICATIONS_MAX = 50

const PORTS_EXTENSION = 'ports'
const PORT_KEY_PREFIX = 'port:'
const GIT_EXTENSION = 'git'

export interface ViewDataInputs {
  workspaces: readonly Workspace[]
  activeWorkspaceId: string | null
  byWorkspace: Readonly<Record<string, WorkspaceLayout | undefined>>
  attention: Readonly<Record<string, PaneAttention>>
  sidebar: readonly ExtensionSidebarItem[]
  approvals: number
  notifications: readonly NotificationEntry[]
  agentOf: (paneId: string) => string | null
  now: number
}

interface PortData {
  port: number
  url: string | null
  workspace: string
  workspaceId: string
}

function portsOf(inputs: ViewDataInputs): PortData[] {
  const names = new Map(inputs.workspaces.map((w) => [w.id, w.name]))
  const out: PortData[] = []
  for (const item of inputs.sidebar) {
    if (item.extId !== PORTS_EXTENSION || !item.key.startsWith(PORT_KEY_PREFIX)) continue
    const port = Number(item.key.slice(PORT_KEY_PREFIX.length))
    if (!Number.isInteger(port) || !item.workspaceId) continue
    out.push({
      port,
      url: item.url ?? null,
      workspace: names.get(item.workspaceId) ?? '',
      workspaceId: item.workspaceId,
    })
  }
  return out.sort((a, b) => a.port - b.port)
}

function gitOf(inputs: ViewDataInputs, workspaceId: string): string | null {
  const item = inputs.sidebar.find(
    (i) => i.extId === GIT_EXTENSION && i.workspaceId === workspaceId && i.text,
  )
  return item?.text ?? null
}

function workspaceData(inputs: ViewDataInputs, ports: PortData[]) {
  return inputs.workspaces.map((w, index) => {
    const layout = inputs.byWorkspace[w.id]
    const ids = layout ? allPanes(layout.root).map((p) => p.id) : []
    return {
      id: w.id,
      index,
      name: w.customName ?? w.name,
      project: w.projectDir ? { name: w.name, path: w.projectDir } : null,
      dir: w.workDir,
      description: w.description ?? null,
      state: w.state,
      unread: unreadCount(inputs.attention, ids),
      active: w.id === inputs.activeWorkspaceId,
      pinned: w.pinned === true,
      panes: ids.length,
      git: gitOf(inputs, w.id),
      ports: ports.filter((p) => p.workspaceId === w.id).map((p) => ({ port: p.port, url: p.url })),
    }
  })
}

function paneData(inputs: ViewDataInputs) {
  const layout = inputs.activeWorkspaceId ? inputs.byWorkspace[inputs.activeWorkspaceId] : undefined
  if (!layout) return []
  return allPanes(layout.root).map((pane) => {
    const attention = inputs.attention[pane.id] ?? EMPTY_ATTENTION
    return {
      id: pane.id,
      title: pane.title,
      kind: pane.kind,
      agent: pane.kind === 'terminal' ? inputs.agentOf(pane.id) : null,
      attention: attention.state,
      unread: attention.unread,
      message: attention.message ?? null,
      active: pane.id === layout.activePaneId,
    }
  })
}

function notificationData(inputs: ViewDataInputs) {
  return [...inputs.notifications]
    .map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body ?? null,
      kind: n.kind,
      from: n.from,
      at: Date.parse(n.ts) || 0,
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, VIEW_NOTIFICATIONS_MAX)
}

export function buildViewScope(
  inputs: ViewDataInputs,
  sources: readonly ViewSource[],
): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  const wants = (s: ViewSource): boolean => sources.includes(s)
  const ports = wants('ports') || wants('workspace') || wants('workspaces') ? portsOf(inputs) : []
  if (wants('workspace') || wants('workspaces')) {
    const workspaces = workspaceData(inputs, ports)
    if (wants('workspaces')) scope.workspaces = workspaces
    if (wants('workspace')) scope.workspace = workspaces.find((w) => w.active) ?? null
  }
  if (wants('panes')) scope.panes = paneData(inputs)
  if (wants('ports')) scope.ports = ports
  if (wants('approvals')) scope.approvals = { pending: inputs.approvals }
  if (wants('notifications')) scope.notifications = notificationData(inputs)
  if (wants('clock')) scope.clock = { now: inputs.now }
  return scope
}
