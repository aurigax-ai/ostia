import { openExtensionPanel } from '@/commands/extensionBridge'
import { fmt, useDict } from '@/i18n/useDict'
import { findPane } from '@/layout/tree'
import {
  NOTIFICATION_TABS,
  type NotificationTab,
  groupNotifications,
  inTab,
} from '@/lib/attention/notificationGroups'
import { revealPane } from '@/lib/attention/workspaceActivity'
import { remoteWorkspacesOf } from '@/lib/workspaces/windowWorkspaces'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { TrayIcon } from '@phosphor-icons/react'
import type { NotificationEntry } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Item, ItemContent, ItemHeader } from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs } from '@/components/ui/tabs'
import { ApprovalsInbox } from './ApprovalsInbox'

const LIST_LIMIT = 50

interface PaneLabel {
  workspaceId: string
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
        if (pane) {
          return {
            workspaceId: workspace.id,
            workspace: workspace.customName ?? workspace.name,
            pane: pane.title,
          }
        }
      }
      for (const workspace of remoteWorkspacesOf(list, windowId)) {
        const pane = workspace.panes.find((p) => p.id === paneId)
        if (pane) return { workspaceId: workspace.id, workspace: workspace.name, pane: pane.title }
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
  const [tab, setTab] = useState<NotificationTab>('all')
  const approvalsPending = useApprovalsStore((s) => s.pending.length)
  const labelOf = usePaneLabels()
  const extensions = useExtensionsStore((s) => s.list)
  const panelOf = (extId: string | undefined) =>
    extId ? (extensions.find((e) => e.id === extId && e.enabled && e.panel) ?? null) : null

  useEffect(() => {
    if (!open) return
    let live = true
    const load = (): void => {
      void window.ostia.notifications.list().then((list) => {
        if (live) setEntries(list.slice(0, LIST_LIMIT))
      })
    }
    load()
    const off = window.ostia.notifications.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [open])

  const time = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )

  const renderEntry = (entry: NotificationEntry): JSX.Element => {
    const where = labelOf(entry.paneId)
    const ext = panelOf(entry.extId)
    const whereText = ext ? ext.name : where ? where.pane : d.attention.closedPane
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
                    entry.panelPath ? { extId: ext.id, path: entry.panelPath } : { extId: ext.id },
                  )
                  setOpen(false)
                } else if (entry.paneId) {
                  if (!revealPane(entry.paneId)) window.ostia.notifications.reveal(entry.paneId)
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
  }

  const groups = groupNotifications(
    entries.filter((e) => inTab(e, tab)),
    (entry) => {
      const ext = panelOf(entry.extId)
      if (ext) return { key: `ext:${ext.id}`, label: ext.name }
      const where = labelOf(entry.paneId)
      return where
        ? { key: where.workspaceId, label: where.workspace }
        : { key: 'closed', label: d.attention.closedPane }
    },
  )

  const tabLabel: Record<NotificationTab, string> = {
    all: d.attention.tabAll,
    needs: d.attention.tabNeeds,
    done: d.attention.tabDone,
    messages: d.attention.tabMessages,
  }

  const label =
    unread > 0 ? fmt(d.attention.notificationsUnread, { n: unread }) : d.attention.notifications

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="count-wrap">
        <PopoverTrigger render={<IconButton size="bar" icon={TrayIcon} label={label} />} />
        {unread > 0 ? <span className="count-dot" aria-hidden="true" /> : null}
      </span>
      <PopoverContent align="end" className="notif-popover">
        <div className="notif-head">
          <span className="notif-title">{d.attention.notifications}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={entries.length === 0 && unread === 0}
            onClick={() => {
              window.ostia.notifications.clear()
              useAttentionStore.getState().markAllRead()
              setEntries([])
            }}
          >
            {d.attention.clearAll}
          </Button>
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as NotificationTab)}>
          <SectionTabsList>
            {NOTIFICATION_TABS.map((t) => {
              const count =
                t === 'needs' ? entries.filter((e) => inTab(e, t)).length + approvalsPending : null
              return (
                <SectionTab key={t} value={t} className="flex-1">
                  {tabLabel[t]}
                  {count ? <span className="tabular-nums text-attn-fg">{count}</span> : null}
                </SectionTab>
              )
            })}
          </SectionTabsList>
        </Tabs>
        {tab === 'all' || tab === 'needs' ? (
          <ApprovalsInbox
            whereOf={(paneId) => {
              const where = labelOf(paneId)
              return where ? `${where.workspace} · ${where.pane}` : null
            }}
            time={time}
            onReveal={() => setOpen(false)}
          />
        ) : null}
        {groups.length === 0 ? (
          <Empty className="p-3">
            <EmptyDescription className="text-ui-sm">
              {tab === 'all' ? d.attention.empty : d.attention.emptyTab}
            </EmptyDescription>
          </Empty>
        ) : (
          <ul className="notif-list" aria-label={d.attention.notifications}>
            {groups.map((group) => (
              <li key={group.key} className="notif-group">
                <div className="notif-group-head">{group.label}</div>
                <ul aria-label={group.label}>{group.entries.map(renderEntry)}</ul>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
