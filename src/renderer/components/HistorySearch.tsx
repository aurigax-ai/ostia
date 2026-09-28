import { useMemo } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import { allPanes } from '../layout/tree'
import { type PaneOrigin, collectHistory } from '../lib/blocks'
import { useBlocksStore } from '../stores/blocksStore'
import { useHistorySearchStore } from '../stores/historySearchStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command'

export function paneOrigins(): Map<string, PaneOrigin> {
  const origins = new Map<string, PaneOrigin>()
  const bySession = useLayoutStore.getState().bySession
  for (const session of useSessionsStore.getState().sessions) {
    const layout = bySession[session.id]
    if (!layout) continue
    for (const pane of allPanes(layout.root)) {
      origins.set(pane.id, { sessionId: session.id, sessionName: session.name })
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
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
            keywords={[e.sessionName, e.cwd ?? '']}
            onSelect={() => insert(e.command)}
            className="history-row"
          >
            <span className="history-command">{e.command}</span>
            <span className="history-meta">
              {e.cwd ? `${e.sessionName} · ${e.cwd}` : e.sessionName}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
