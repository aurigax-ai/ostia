import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import { currentDict } from '@/lib/app/useDict'
import { findPane } from '@/lib/layout/tree'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

function paneTitle(paneId: string): string | undefined {
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    const pane = layout ? findPane(layout.root, paneId) : null
    if (pane) return pane.title
  }
  return undefined
}

export function postAgentNotification(
  paneId: string,
  state: 'waiting' | 'done',
  message: string | undefined,
  seen: boolean,
): void {
  const d = currentDict()
  const kind = state === 'waiting' ? 'agentWaiting' : 'agentDone'
  window.ostia.notifications.post({
    paneId,
    kind: state,
    title: state === 'waiting' ? d.attention.agentWaiting : d.attention.agentDone,
    body: message ?? paneTitle(paneId),
    desktop: wantsDesktopBanner(useSettingsStore.getState().notifications, kind, seen),
  })
}
