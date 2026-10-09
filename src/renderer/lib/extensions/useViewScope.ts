import { runningAgentOf } from '@/lib/agents/paneAgent'
import { useCoreWatchAll } from '@/lib/workspaces/coreWatch'
import { useApprovalsStore } from '@/stores/approvalsStore'
import { useAttentionStore } from '@/stores/attentionStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { NotificationEntry } from '@shared/types'
import type { ViewFormat } from '@shared/views/viewBindings'
import type { ViewDoc } from '@shared/views/views'
import { useEffect, useMemo, useState } from 'react'
import { buildViewScope } from './viewData'

export const VIEW_TICK_MS = 1000

function useNow(ticks: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticks) return
    const timer = setInterval(() => setNow(Date.now()), VIEW_TICK_MS)
    return () => clearInterval(timer)
  }, [ticks])
  return now
}

function useNotifications(wanted: boolean): NotificationEntry[] {
  const [list, setList] = useState<NotificationEntry[]>([])
  useEffect(() => {
    if (!wanted) return
    let live = true
    const load = (): void => {
      void window.ostia.notifications
        .list()
        .then((entries) => {
          if (live) setList(entries)
        })
        .catch(() => {})
    }
    load()
    const off = window.ostia.notifications.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [wanted])
  return list
}

function safeLocale(locale: string): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : 'en'
  } catch {
    return 'en'
  }
}

export function useViewScope(doc: ViewDoc): { scope: Record<string, unknown>; format: ViewFormat } {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const attention = useAttentionStore((s) => s.byPane)
  const sidebar = useExtensionsStore((s) => s.sidebar)
  const workspaceChips = useExtensionsStore((s) => s.workspaceChips)
  const approvals = useApprovalsStore((s) => s.pending.length)
  const running = useBlocksStore((s) => s.running)
  const agentBlocks = useBlocksStore((s) => s.agentBlocks)
  const locale = useSettingsStore((s) => s.locale)
  const notifications = useNotifications(doc.sources.includes('notifications'))
  const workspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces])
  const listsWorkspaces = doc.sources.includes('workspaces') || doc.sources.includes('workspace')
  useCoreWatchAll('git', workspaceIds, listsWorkspaces)
  useCoreWatchAll('ports', workspaceIds, listsWorkspaces || doc.sources.includes('ports'))
  const now = useNow(doc.ticks)

  const scope = useMemo(() => {
    void running
    void agentBlocks
    return buildViewScope(
      {
        workspaces,
        activeWorkspaceId,
        byWorkspace,
        attention,
        sidebar,
        workspaceChips,
        approvals,
        notifications,
        agentOf: runningAgentOf,
        now,
      },
      doc.sources,
    )
  }, [
    doc.sources,
    workspaces,
    activeWorkspaceId,
    byWorkspace,
    attention,
    sidebar,
    workspaceChips,
    approvals,
    notifications,
    running,
    agentBlocks,
    now,
  ])
  const format = useMemo(() => ({ now, locale: safeLocale(locale) }), [now, locale])
  return { scope, format }
}
