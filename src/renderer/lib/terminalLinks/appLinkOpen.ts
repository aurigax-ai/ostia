import { appLinkScheme } from '@shared/common/externalLinks'
import { appLinkAsks } from '@shared/terminal/appLinkSettings'
import { saveSettingsNow, useSettingsStore } from '@/stores/app/settingsStore'
import { useAppLinkStore } from '@/stores/terminal/appLinkStore'

export async function openAppLink(paneId: string, url: string): Promise<void> {
  const scheme = appLinkScheme(url)
  const info = await window.ostia.openPath.linkInfo(url)
  const { show } = useAppLinkStore.getState()
  if (!scheme || !info.ok) {
    show(paneId, { kind: 'none', url })
    return
  }
  if (appLinkAsks(useSettingsStore.getState().terminal, scheme)) {
    show(paneId, { kind: 'ask', url, app: info.app })
    return
  }
  const result = await window.ostia.openPath.openLink(url, false)
  if (result.ok) return
  show(
    paneId,
    result.error === 'not-allowed'
      ? { kind: 'ask', url, app: info.app }
      : { kind: 'failed', url, app: info.app },
  )
}

export async function confirmAppLink(
  paneId: string,
  url: string,
  app: string,
  always: boolean,
): Promise<void> {
  const scheme = appLinkScheme(url)
  const settings = useSettingsStore.getState()
  if (always && scheme && !settings.terminal.allowedAppSchemes.includes(scheme)) {
    settings.setTerminal({ allowedAppSchemes: [...settings.terminal.allowedAppSchemes, scheme] })
    await saveSettingsNow()
  }
  const result = await window.ostia.openPath.openLink(url, true)
  useAppLinkStore.getState().release(paneId)
  if (!result.ok) useAppLinkStore.getState().show(paneId, { kind: 'failed', url, app })
}

export function dismissAppLink(paneId: string): void {
  useAppLinkStore.getState().release(paneId)
}
