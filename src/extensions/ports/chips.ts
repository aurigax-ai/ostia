import type { PaneChipValue, PaneInfo } from '../sdk'
import type { TreeInfo } from './scan'
import { type PortHost, portUrl } from './sidebar'
import { sshLabel } from './ssh'

export const SSH_CHIP = 'ssh'
export const PORTS_CHIP = 'ports'
export const CHIP_TEXT_MAX = 40

export function portsText(ports: readonly number[]): string {
  let text = ''
  for (let i = 0; i < ports.length; i++) {
    const next = text ? `${text} :${ports[i]}` : `:${ports[i]}`
    const more = i + 1 < ports.length ? ` +${ports.length - i - 1}` : ''
    if (next.length + more.length > CHIP_TEXT_MAX) return `${text} +${ports.length - i}`
    text = next
  }
  return text
}

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
        text: portsText(tree.ports),
        url: portUrl(tree.ports[0], host),
      })
    }
  }
  return out
}

export function chipSlot(chip: Pick<PaneChipValue, 'paneId' | 'id'>): string {
  return `${chip.paneId}\u0000${chip.id}`
}
