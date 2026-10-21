import {
  PANE_CHIP_ITEMS_MAX,
  type PaneChip,
  type SidebarTone,
  type WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PORTS_CHIP, SSH_CHIP } from '../../shared/boards/git'
import type { PortHost } from '../../shared/boards/ports'
import type { PaneEntry } from '../panes/paneList'
import type { TreeInfo } from './scan'
import { portUrl, type WorkspaceProcesses } from './sidebar'
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
      items: group.ports.slice(0, PANE_CHIP_ITEMS_MAX).map(({ port, name }) => ({
        text: `:${port}`,
        ...(name ? { detail: name } : {}),
        url: portUrl(port, host),
      })),
    })
  }
  return out
}
