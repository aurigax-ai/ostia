import { busLabel, busPreview } from '@shared/agents/busMessages'
import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import { currentDict, fmt } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { isPaneViewed } from './workspaceActivity'

export function announceBusMessage(paneId: string, from: unknown, text: unknown): void {
  const d = currentDict()
  const label = busLabel(from)
  const title = label ? fmt(d.attention.messageFrom, { from: label }) : d.attention.messageFromPane
  const body = busPreview(text)
  const seen = isPaneViewed(paneId)
  window.ostia.notifications.post({
    paneId,
    kind: 'message',
    title,
    body: body || undefined,
    desktop: wantsDesktopBanner(useSettingsStore.getState().notifications, 'message', seen),
  })
}
