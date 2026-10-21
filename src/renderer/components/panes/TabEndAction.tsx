import { LockSimpleIcon, XIcon } from '@phosphor-icons/react'
import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'

export function TabEndAction({
  pane,
  showClose,
  closeLabel,
  closeCommand,
}: {
  pane: PaneNode
  showClose: boolean
  closeLabel: string
  closeCommand?: string
}): JSX.Element | null {
  const d = useDict()
  if (pane.locked) {
    return (
      <IconButton
        icon={LockSimpleIcon}
        label={d.pane.unlock}
        className="pane-tab-lock"
        onClick={() => commands.exec('pane.toggleLock', { paneId: pane.id })}
      />
    )
  }
  if (!showClose) return null
  return (
    <IconButton
      icon={XIcon}
      label={closeLabel}
      command={closeCommand}
      className="pane-tab-close hover:text-attn-fg"
      onClick={() => commands.exec('pane.close', { paneId: pane.id })}
    />
  )
}
