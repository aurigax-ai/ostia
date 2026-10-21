import type {
  ExtensionIcon,
  SidebarKind,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { PortHost } from '../../shared/boards/ports'
import type { PaneEntry } from '../panes/paneList'
import { addOwner, type ListeningPort, sortedPorts } from './procfs'
import type { TreeInfo } from './scan'

const SSH_KEY = 'ssh'

export interface WorkspaceProcesses {
  ports: ListeningPort[]
  ssh: string[]
}

export interface SidebarEntry {
  workspaceId: string
  key: string
  text: string
  icon?: ExtensionIcon
  badge?: string
  kind: SidebarKind
}

export function terminalPids(panes: PaneEntry[]): number[] {
  return panes.filter((p) => p.kind === 'terminal' && p.pid).map((p) => p.pid as number)
}

export function groupByWorkspace(
  panes: PaneEntry[],
  trees: Map<number, TreeInfo>,
): Map<string, WorkspaceProcesses> {
  const owners = new Map<string, Map<number, string | undefined>>()
  const ssh = new Map<string, Set<string>>()
  for (const pane of panes) {
    const tree = pane.pid ? trees.get(pane.pid) : undefined
    if (!tree) continue
    const ports = owners.get(pane.workspaceId) ?? new Map<number, string | undefined>()
    const hosts = ssh.get(pane.workspaceId) ?? new Set<string>()
    for (const { port, name } of tree.ports) addOwner(ports, port, name)
    if (tree.ssh) hosts.add(tree.ssh.host)
    owners.set(pane.workspaceId, ports)
    ssh.set(pane.workspaceId, hosts)
  }
  const out = new Map<string, WorkspaceProcesses>()
  for (const [workspaceId, ports] of owners) {
    out.set(workspaceId, {
      ports: sortedPorts(ports),
      ssh: [...(ssh.get(workspaceId) ?? [])].sort(),
    })
  }
  return out
}

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
      badge: 'SSH',
      kind: 'live',
    })
  }
  return out
}
