import { insertCommand } from '@/lib/terminal/blockActions'
import { useWorkflowsStore } from '@/stores/terminal/workflowsStore'

export type Delivery = 'inserted' | 'copied'

const SUGGESTED_NAME_MAX = 60

export async function openWorkflowPicker(
  workspaceId: string | null,
  targetPaneId: string | null,
): Promise<void> {
  const listing = await window.ostia.workflows.list(workspaceId)
  useWorkflowsStore.getState().showPicker(listing, targetPaneId)
}

export async function deliverCommand(paneId: string | null, command: string): Promise<Delivery> {
  if (paneId && insertCommand(paneId, command)) return 'inserted'
  await navigator.clipboard.writeText(command)
  return 'copied'
}

export function suggestedName(command: string): string {
  const line = command.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > SUGGESTED_NAME_MAX ? `${line.slice(0, SUGGESTED_NAME_MAX - 1)}…` : line
}

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ]
}
