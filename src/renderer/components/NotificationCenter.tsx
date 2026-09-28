import type { NotificationEntry } from '@shared/types'
import { Bell } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { openExtensionPanel } from '../commands/extensionBridge'
import { fmt, useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { revealPane } from '../lib/sessionActivity'
import { useAttentionStore } from '../stores/attentionStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const LIST_LIMIT = 50

interface PaneLabel {
  session: string
  pane: string
}

function usePaneLabels(): (paneId: string | undefined) => PaneLabel | null {
  const bySession = useLayoutStore((s) => s.bySession)
  const sessions = useSessionsStore((s) => s.sessions)
  return useCallback(
    (paneId) => {
      if (!paneId) return null
      for (const session of sessions) {
        const layout = bySession[session.id]
        const pane = layout ? findPane(layout.root, paneId) : null
        if (pane) return { session: session.name, pane: pane.title }
      }
      return null
    },
    [bySession, sessions],
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
        <PopoverTrigger render={<IconButton size="bar" icon={Bell} label={label} />} />
        {unread > 0 ? (
          <span className="bell-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
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
        {entries.length === 0 ? (
          <p className="notif-empty">{d.attention.empty}</p>
        ) : (
          <ul className="notif-list" aria-label={d.attention.notifications}>
            {entries.map((entry) => {
              const where = labelOf(entry.paneId)
              const ext = panelOf(entry.extId)
              const whereText = ext
                ? ext.name
                : where
                  ? `${where.session} · ${where.pane}`
                  : d.attention.closedPane
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="notif-row"
                    disabled={!where && !ext}
                    onClick={() => {
                      if (ext) {
                        openExtensionPanel({ extId: ext.id })
                        setOpen(false)
                      } else if (entry.paneId && revealPane(entry.paneId)) setOpen(false)
                    }}
                  >
                    <span className="notif-meta">
                      <span className="notif-where">{whereText}</span>
                      <time dateTime={entry.ts}>{time.format(new Date(entry.ts))}</time>
                    </span>
                    <span className="notif-msg">
                      {entry.body ? `${entry.title}: ${entry.body}` : entry.title}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
