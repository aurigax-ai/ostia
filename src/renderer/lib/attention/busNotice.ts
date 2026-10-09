import { currentDict, fmt } from '@/i18n/useDict'
import { useSettingsStore } from '@/stores/settingsStore'
import { busLabel, busPreview } from '@shared/agents/busMessages'
import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import { isPaneViewed, signalPane } from './workspaceActivity'

export function announceBusMessage(paneId: string, from: unknown, text: unknown): void {
  const d = currentDict()
  const label = busLabel(from)
  const title = label ? fmt(d.attention.messageFrom, { from: label }) : d.attention.messageFromPane
  const body = busPreview(text)
  const seen = isPaneViewed(paneId)
  const at = Date.now()
  signalPane(paneId, {
    type: 'notify',
    message: body ? `${title}: ${body}` : title,
    waiting: false,
    at,
  })
  window.ostia.notifications.post({
    paneId,
    kind: 'message',
    title,
    body: body || undefined,
    desktop: wantsDesktopBanner(useSettingsStore.getState().notifications, 'message', seen),
  })
}
