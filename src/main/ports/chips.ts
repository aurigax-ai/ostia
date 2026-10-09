import {
  PANE_CHIP_ITEMS_MAX,
  type PaneChip,
  type SidebarTone,
  type WorkspaceChip,
} from '../../shared/extensions'
import { PORTS_CHIP, SSH_CHIP } from '../../shared/git'
import type { PortHost } from '../../shared/ports'
import type { PaneEntry } from '../panes/paneList'
import type { TreeInfo } from './scan'
import { type WorkspaceProcesses, portUrl } from './sidebar'
import { sshLabel } from './ssh'

export type PaneChipValue = Omit<PaneChip, 'extId' | 'tone'> & { tone?: SidebarTone }
export type WorkspaceChipValue = Omit<WorkspaceChip, 'extId' | 'tone'> & { tone?: SidebarTone }

export function paneChipValues(panes: PaneEntry[], trees: Map<number, TreeInfo>): PaneChipValue[] {
  const out: PaneChipValue[] = []
  for (const pane of panes) {
    if (pane.kind !== 'terminal' || !pane.pid) continue
    const ssh = trees.get(pane.pid)?.ssh
    if (ssh) out.push({ paneId: pane.paneId, id: SSH_CHIP, text: sshLabel(ssh), tone: 'brand' })
  }
  return out
}

export function workspaceChipValues(
  groups: Map<string, WorkspaceProcesses>,
  host: PortHost,
): WorkspaceChipValue[] {
  const out: WorkspaceChipValue[] = []
  for (const [workspaceId, group] of groups) {
    if (group.ports.length === 0) continue
    out.push({
      workspaceId,
      id: PORTS_CHIP,
      icon: 'plugs',
      text: String(group.ports.length),
      items: group.ports
        .slice(0, PANE_CHIP_ITEMS_MAX)
        .map((port) => ({ text: `:${port}`, url: portUrl(port, host) })),
    })
  }
  return out
}

export function chipSlot(chip: Pick<PaneChipValue, 'paneId' | 'id'>): string {
  return `${chip.paneId}\u0000${chip.id}`
}

export function workspaceChipSlot(chip: Pick<WorkspaceChipValue, 'workspaceId' | 'id'>): string {
  return `${chip.workspaceId}\u0000${chip.id}`
}
