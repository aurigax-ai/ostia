import { busLabel, busPreview } from '../shared/busMessages'
import type { CommandResult, CommandTarget } from '../shared/types'
import { targetOf } from './attention'
import type { PaneIdentity } from './idRegistry'
import type { PaneEntry, WorkspaceEntry } from './paneList'

export interface BusNoticeDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listPanes: () => Promise<PaneEntry[]>
  listWorkspaces: () => Promise<WorkspaceEntry[]>
}

export async function senderLabel(
  deps: Pick<BusNoticeDeps, 'listPanes' | 'listWorkspaces'>,
  from: PaneIdentity,
  to: PaneIdentity,
): Promise<string> {
  const pane = (await deps.listPanes()).find((entry) => entry.paneId === from.externalId)
  const title = busLabel(pane?.title)
  if (title && from.workspaceId === to.workspaceId) return title
  const workspaces = await deps.listWorkspaces()
  const name = workspaces.find((entry) => entry.workspaceId === from.workspaceId)?.name
  return busLabel([name, title].filter(Boolean).join(' · '))
}

export async function announceBusMessage(
  deps: BusNoticeDeps,
  from: PaneIdentity,
  to: PaneIdentity,
  text: string,
): Promise<void> {
  const label = await senderLabel(deps, from, to).catch(() => '')
  await deps.execCommand(targetOf(to), 'attention.message', {
    from: label,
    text: busPreview(text),
  })
}
