import type { ExtensionIcon, SidebarKind } from '../../shared/extensions'
import type { PaneInfo } from '../sdk'
import type { TreeInfo } from './scan'

export const SSH_KEY = 'ssh'

export interface WorkspaceProcesses {
  ports: number[]
  ssh: string[]
}

export interface SidebarEntry {
  workspaceId: string
  key: string
  text: string
  icon?: ExtensionIcon
  kind: SidebarKind
}

export function terminalPids(panes: PaneInfo[]): number[] {
  return panes.filter((p) => p.kind === 'terminal' && p.pid).map((p) => p.pid as number)
}

export function groupByWorkspace(
  panes: PaneInfo[],
  trees: Map<number, TreeInfo>,
): Map<string, WorkspaceProcesses> {
  const out = new Map<string, WorkspaceProcesses>()
  for (const pane of panes) {
    const tree = pane.pid ? trees.get(pane.pid) : undefined
    if (!tree) continue
    const group = out.get(pane.workspaceId) ?? { ports: [], ssh: [] }
    for (const port of tree.ports) if (!group.ports.includes(port)) group.ports.push(port)
    if (tree.ssh && !group.ssh.includes(tree.ssh.host)) group.ssh.push(tree.ssh.host)
    out.set(pane.workspaceId, group)
  }
  for (const group of out.values()) {
    group.ports.sort((a, b) => a - b)
    group.ssh.sort()
  }
  return out
}

export type PortHost = 'localhost' | '127.0.0.1'

export function portUrl(port: number, host: PortHost = 'localhost'): string {
  return `http://${host}:${port}/`
}

export function sidebarEntries(groups: Map<string, WorkspaceProcesses>): SidebarEntry[] {
  const out: SidebarEntry[] = []
  for (const [workspaceId, group] of groups) {
    if (group.ssh.length === 0) continue
    out.push({
      workspaceId,
      key: SSH_KEY,
      text: group.ssh.join(' '),
      icon: 'server',
      kind: 'live',
    })
  }
  return out
}

export function slotOf(entry: Pick<SidebarEntry, 'workspaceId' | 'key'>): string {
  return `${entry.workspaceId}\u0000${entry.key}`
}
