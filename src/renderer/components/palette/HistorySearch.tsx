import { BookmarkSimpleIcon } from '@phosphor-icons/react'
import { type JSX, useMemo } from 'react'
import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useDict } from '@/lib/app/useDict'
import { allPanes } from '@/lib/layout/tree'
import { fileOnlyCommands } from '@/lib/prompt/historyRank'
import { useFileHistory } from '@/lib/prompt/useFileHistory'
import { collectHistory, type PaneOrigin } from '@/lib/terminal/blocks'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHistorySearchStore } from '@/stores/terminal/historySearchStore'
import { useSnippetsStore } from '@/stores/terminal/snippetsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const FILE_ENTRIES_MAX = 1000

function activePaneId(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  return layout?.activePaneId ?? null
}

function paneOrigins(): Map<string, PaneOrigin> {
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

  const fileHistoryOn = useSettingsStore((s) => s.behavior.historySuggestions)
  const fileHistory = useFileHistory(open ? activePaneId() : null, open && fileHistoryOn)

  const entries = useMemo(() => (open ? collectHistory(byPane, paneOrigins()) : []), [open, byPane])
  const fromFile = useMemo(
    () =>
      fileOnlyCommands(
        fileHistory,
        entries.map((e) => e.command),
      ).slice(0, FILE_ENTRIES_MAX),
    [fileHistory, entries],
  )

  const insert = (command: string): void => {
    setOpen(false)
    void commands.exec('history.insert', { command })
  }

  const saveAsSnippet = (command: string): void => {
    setOpen(false)
    useSnippetsStore.getState().startSave(command)
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
              label={d.history.saveAsSnippet}
              hintSide="left"
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation()
                saveAsSnippet(e.command)
              }}
            />
          </CommandItem>
        ))}
        {fromFile.map((command) => (
          <CommandItem
            key={command}
            value={command}
            onSelect={() => insert(command)}
            className="history-row"
          >
            <span className="history-text">
              <span className="history-command">{command}</span>
              <span className="history-meta">{d.history.shellHistory}</span>
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
