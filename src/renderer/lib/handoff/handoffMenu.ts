import { commands, commandWording } from '@/commands/registry'
import { currentDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const HANDOFF_COMMAND = 'handoff.start'

function handoffCommand() {
  return commands.list().find((c) => c.id === HANDOFF_COMMAND && c.listed?.() === true)
}

export function canHandOff(pane: PaneNode, workspaceId: string): boolean {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  return (
    handoffCommand() !== undefined &&
    workspace !== undefined &&
    workspace.kind !== 'scratch' &&
    useSandboxStore.getState().enabled[workspaceId] !== true &&
    pane.kind === 'terminal' &&
    pane.resume?.agent === 'claude'
  )
}

export function askForHandoff(): void {
  const command = handoffCommand()
  if (command)
    useUIStore.getState().openPalette('search', commandWording(command, currentDict()).title)
}
