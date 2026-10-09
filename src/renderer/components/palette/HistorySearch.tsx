import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useDict } from '@/i18n/useDict'
import { allPanes } from '@/layout/tree'
import { type PaneOrigin, collectHistory } from '@/lib/terminal/blocks'
import { useBlocksStore } from '@/stores/blocksStore'
import { useHistorySearchStore } from '@/stores/historySearchStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useWorkflowsStore } from '@/stores/workflowsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { BookmarkSimpleIcon } from '@phosphor-icons/react'
import { useMemo } from 'react'

export function paneOrigins(): Map<string, PaneOrigin> {
  const origins = new Map<string, PaneOrigin>()
  const byWorkspace = useLayoutStore.getState().byWorkspace
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const layout = workspace.kind === 'scratch' ? undefined : byWorkspace[workspace.id]
    if (!layout) continue
    for (const pane of allPanes(layout.root)) {
      origins.set(pane.id, { workspaceId: workspace.id, workspaceName: workspace.name })
    }
  }
  return origins
}

export function HistorySearch(): JSX.Element {
  const d = useDict()
  const open = useHistorySearchStore((s) => s.open)
  const setOpen = useHistorySearchStore((s) => s.setOpen)
  const byPane = useBlocksStore((s) => s.byPane)

  const entries = useMemo(() => (open ? collectHistory(byPane, paneOrigins()) : []), [open, byPane])

  const insert = (command: string): void => {
    setOpen(false)
    void commands.exec('history.insert', { command })
  }

  const saveAsWorkflow = (command: string): void => {
    setOpen(false)
    useWorkflowsStore.getState().startSave(command)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      className="top-[12vh] sm:max-w-2xl"
      title={d.history.title}
      description={d.history.placeholder}
    >
      <CommandInput placeholder={d.history.placeholder} />
      <CommandList>
        <CommandEmpty>{d.history.empty}</CommandEmpty>
        {entries.map((e) => (
          <CommandItem
            key={e.command}
            value={e.command}
            keywords={[e.workspaceName, e.cwd ?? '']}
            onSelect={() => insert(e.command)}
            className="history-row"
          >
            <span className="history-text">
              <span className="history-command">{e.command}</span>
              <span className="history-meta">
                {e.cwd ? `${e.workspaceName} · ${e.cwd}` : e.workspaceName}
              </span>
            </span>
            <IconButton
              icon={BookmarkSimpleIcon}
              label={d.history.saveAsWorkflow}
              hintSide="left"
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation()
                saveAsWorkflow(e.command)
              }}
            />
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
