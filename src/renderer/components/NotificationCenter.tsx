import { cn } from '@/lib/utils'
import { BellIcon } from '@phosphor-icons/react'
import type { NotificationEntry } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { openExtensionPanel } from '../commands/extensionBridge'
import { fmt, useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { remoteWorkspacesOf } from '../lib/windowWorkspaces'
import { revealPane } from '../lib/workspaceActivity'
import { useAttentionStore } from '../stores/attentionStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWindowsStore } from '../stores/windowsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ApprovalsInbox } from './ApprovalsInbox'
import { IconButton } from './IconButton'
import { ATTENTION_BADGE } from './attentionStyles'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Empty, EmptyDescription } from './ui/empty'
import { Item, ItemContent, ItemHeader } from './ui/item'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const LIST_LIMIT = 50

interface PaneLabel {
  workspace: string
  pane: string
}

function usePaneLabels(): (paneId: string | undefined) => PaneLabel | null {
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const windowId = useWindowsStore((s) => s.windowId)
  const list = useWindowsStore((s) => s.list)
  return useCallback(
    (paneId) => {
      if (!paneId) return null
      for (const workspace of workspaces) {
        const layout = byWorkspace[workspace.id]
        const pane = layout ? findPane(layout.root, paneId) : null
        if (pane) return { workspace: workspace.name, pane: pane.title }
      }
      for (const workspace of remoteWorkspacesOf(list, windowId)) {
        const pane = workspace.panes.find((p) => p.id === paneId)
        if (pane) return { workspace: workspace.name, pane: pane.title }
      }
      return null
    },
    [byWorkspace, workspaces, list, windowId],
  )
}

export function useUnreadTotal(): number {
  return useAttentionStore((s) => {
    let n = 0
    for (const a of Object.values(s.byPane)) if (a.unread) n += 1
    return n
  })
}

export function NotificationCenter(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const unread = useUnreadTotal()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<NotificationEntry[]>([])
  const labelOf = usePaneLabels()
  const extensions = useExtensionsStore((s) => s.list)
  const panelOf = (extId: string | undefined) =>
    extId ? (extensions.find((e) => e.id === extId && e.enabled && e.panel) ?? null) : null

  useEffect(() => {
    if (!open) return
    let live = true
    const load = (): void => {
      void window.pine.notifications.list().then((list) => {
        if (live) setEntries(list.slice(0, LIST_LIMIT))
      })
    }
    load()
    const off = window.pine.notifications.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [open])

  const time = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )

  const label =
    unread > 0 ? fmt(d.attention.notificationsUnread, { n: unread }) : d.attention.notifications

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="bell-wrap">
        <PopoverTrigger render={<IconButton size="bar" icon={BellIcon} label={label} />} />
        {unread > 0 ? (
          <Badge
            variant="outline"
            className={cn(ATTENTION_BADGE, 'bell-count bg-surface-1')}
            aria-hidden="true"
          >
            {unread > 99 ? '99+' : unread}
          </Badge>
        ) : null}
      </span>
      <PopoverContent align="end" className="notif-popover">
        <div className="notif-head">
          <span className="notif-title">{d.attention.notifications}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={entries.length === 0 && unread === 0}
            onClick={() => {
              window.pine.notifications.clear()
              useAttentionStore.getState().markAllRead()
              setEntries([])
            }}
          >
            {d.attention.clearAll}
          </Button>
        </div>
        <ApprovalsInbox
          whereOf={(paneId) => {
            const where = labelOf(paneId)
            return where ? `${where.workspace} · ${where.pane}` : null
          }}
          time={time}
          onReveal={() => setOpen(false)}
        />
        {entries.length === 0 ? (
          <Empty className="p-3">
            <EmptyDescription className="text-ui-sm">{d.attention.empty}</EmptyDescription>
          </Empty>
        ) : (
          <ul className="notif-list" aria-label={d.attention.notifications}>
            {entries.map((entry) => {
              const where = labelOf(entry.paneId)
              const ext = panelOf(entry.extId)
              const whereText = ext
                ? ext.name
                : where
                  ? `${where.workspace} · ${where.pane}`
                  : d.attention.closedPane
              return (
                <li key={entry.id}>
                  <Item
                    size="xs"
                    className="gap-0.5 p-1.5 text-left hover:bg-surface-2 disabled:text-fg-muted disabled:hover:bg-transparent"
                    render={
                      <button
                        type="button"
                        disabled={!where && !ext}
                        onClick={() => {
                          if (ext) {
                            openExtensionPanel(
                              entry.panelPath
                                ? { extId: ext.id, path: entry.panelPath }
                                : { extId: ext.id },
                            )
                            setOpen(false)
                          } else if (entry.paneId) {
                            if (!revealPane(entry.paneId)) {
                              window.pine.notifications.reveal(entry.paneId)
                            }
                            setOpen(false)
                          }
                        }}
                      />
                    }
                  >
                    <ItemHeader className="text-fg-muted text-ui-xs tabular-nums">
                      <span className="truncate">{whereText}</span>
                      <time dateTime={entry.ts}>{time.format(new Date(entry.ts))}</time>
                    </ItemHeader>
                    <ItemContent className="basis-full text-ui-sm [overflow-wrap:anywhere]">
                      {entry.body ? `${entry.title}: ${entry.body}` : entry.title}
                    </ItemContent>
                  </Item>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
