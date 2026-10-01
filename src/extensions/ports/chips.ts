import { PANE_CHIP_ITEMS_MAX } from '../../shared/extensions'
import type { PaneChipValue, PaneInfo } from '../sdk'
import type { TreeInfo } from './scan'
import { type PortHost, portUrl } from './sidebar'
import { sshLabel } from './ssh'

export const SSH_CHIP = 'ssh'
export const PORTS_CHIP = 'ports'
export function paneChipValues(
  panes: PaneInfo[],
  trees: Map<number, TreeInfo>,
  host: PortHost,
): PaneChipValue[] {
  const out: PaneChipValue[] = []
  for (const pane of panes) {
    if (pane.kind !== 'terminal' || !pane.pid) continue
    const tree = trees.get(pane.pid)
    if (!tree) continue
    if (tree.ssh) {
      out.push({ paneId: pane.paneId, id: SSH_CHIP, text: sshLabel(tree.ssh), tone: 'brand' })
    }
    if (tree.ports.length > 0) {
      out.push({
        paneId: pane.paneId,
        id: PORTS_CHIP,
        icon: 'plugs',
        text: String(tree.ports.length),
        items: tree.ports
          .slice(0, PANE_CHIP_ITEMS_MAX)
          .map((port) => ({ text: `:${port}`, url: portUrl(port, host) })),
      })
    }
  }
  return out
}

export function chipSlot(chip: Pick<PaneChipValue, 'paneId' | 'id'>): string {
  return `${chip.paneId}\u0000${chip.id}`
}
