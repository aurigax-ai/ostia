import { AppWindowIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { PathText } from '@/components/common/MachineValue'
import { WorkspaceBadges } from '@/components/sidebar/WorkspaceBadges'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useDict } from '@/lib/app/useDict'
import { revealPane } from '@/lib/attention/workspaceActivity'
import { allPanes } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { symbolOf } from '@/lib/palette/paletteModes'
import { selectWorkspace } from '@/lib/workspaces/selectWorkspace'
import { type RemoteWorkspace, remoteWorkspacesOf } from '@/lib/workspaces/windowWorkspaces'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { ItemRow } from './PaletteItemRow'
import { GROUP_CLASS } from './paletteClasses'

export interface Places {
  workspaces: Workspace[]
  remote: RemoteWorkspace[]
  tabs: { pane: PaneNode; workspace: Workspace }[]
}

export const EMPTY_PLACES: Places = { workspaces: [], remote: [], tabs: [] }

export function snapshotPlaces(): Places {
  const { workspaces } = useWorkspacesStore.getState()
  const { byWorkspace } = useLayoutStore.getState()
  const tabs = workspaces.flatMap((workspace) => {
    const layout = byWorkspace[workspace.id]
    return layout ? allPanes(layout.root).map((pane) => ({ pane, workspace })) : []
  })
  const { list, windowId } = useWindowsStore.getState()
  return { workspaces, remote: remoteWorkspacesOf(list, windowId), tabs }
}

export function WorkspaceItems({
  workspaces,
  remote,
  onDone,
}: {
  workspaces: Workspace[]
  remote: RemoteWorkspace[]
  onDone: () => void
}): JSX.Element | null {
  const d = useDict()
  if (workspaces.length === 0 && remote.length === 0) return null
  const symbol = symbolOf('workspaces')
  return (
    <CommandGroup heading={d.palette.modes.workspaces} className={GROUP_CLASS}>
      {workspaces.map((w) => {
        const name = workspaceTitle(w)
        return (
          <CommandItem
            key={w.id}
            value={`${symbol} ${name} ${w.workDir} ${w.projectDir ?? ''} ${w.id}`}
            onSelect={() => {
              selectWorkspace(w.id)
              onDone()
            }}
          >
            <ItemRow
              name={name}
              meta={
                <PathText
                  className="text-inherit"
                  max={Number.POSITIVE_INFINITY}
                  path={w.projectDir ?? w.workDir}
                />
              }
              after={<WorkspaceBadges workspace={w} marksOnly />}
            />
          </CommandItem>
        )
      })}
      {remote.map((w) => (
        <CommandItem
          key={w.id}
          value={`${symbol} ${w.name} ${w.workDir} ${w.id}`}
          onSelect={() => {
            window.ostia.windows.focusWorkspace(w.id, false, true)
            onDone()
          }}
        >
          <AppWindowIcon aria-label={d.window.inOtherWindow} />
          <ItemRow name={w.name} meta={w.workDir} mono />
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

export function TabItems({
  tabs,
  onDone,
}: {
  tabs: Places['tabs']
  onDone: () => void
}): JSX.Element | null {
  const d = useDict()
  if (tabs.length === 0) return null
  const symbol = symbolOf('tabs')
  return (
    <CommandGroup heading={d.palette.modes.tabs} className={GROUP_CLASS}>
      {tabs.map(({ pane, workspace }) => {
        const where = workspaceTitle(workspace)
        return (
          <CommandItem
            key={pane.id}
            value={`${symbol} ${pane.title} ${where} ${pane.kind} ${pane.id}`}
            onSelect={() => {
              revealPane(pane.id)
              onDone()
            }}
          >
            <ItemRow name={pane.title} meta={where} />
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
