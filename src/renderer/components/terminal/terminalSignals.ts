import { CHAT_CONTEXT_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import { terminalNotification } from '@/lib/agents/paneAgent'
import { reducedMotionNow } from '@/lib/app/motion'
import { tail } from '@/lib/assist/askContext'
import {
  KittyNotificationAssembler,
  notificationMessage,
  type OscNotification,
  parseOsc9,
  parseOsc99,
  parseOsc777,
} from '@/lib/attention/attention'
import { bellActions, createBellThrottle } from '@/lib/attention/bell'
import { createBellFlash } from '@/lib/attention/bellFlash'
import { isPaneViewed, isPaneVisible, signalPane } from '@/lib/attention/workspaceActivity'
import { registerOsc52 } from '@/lib/terminal/osc52'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { commitProgramTitle } from '@/lib/terminal/paneTitle'
import { installPrimarySelection } from '@/lib/terminal/primarySelection'
import { terminalTitle } from '@/lib/terminal/terminalTitle'
import { createTitleCommitter } from '@/lib/terminal/titleCommit'
import { isLinux } from '@/platform'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLiveSelectionStore } from '@/stores/terminal/liveSelectionStore'
import type { TerminalSession } from './terminalSession'

export function attachTerminalSignals({
  host,
  term,
  paneId,
  workspaceIdRef,
  session,
}: {
  host: HTMLElement
  term: OstiaTerminal
  paneId: string
  workspaceIdRef: { current: string }
  session: TerminalSession
}): () => void {
  const notifyFromTerminal = (n: OscNotification | null): boolean => {
    if (!n || session.replaying) return true
    signalPane(paneId, terminalNotification(paneId, notificationMessage(n), Date.now()))
    window.ostia.notifications.post({
      paneId,
      kind: 'message',
      title: n.title,
      body: n.body,
      desktop: wantsDesktopBanner(
        useSettingsStore.getState().notifications,
        'message',
        document.hasFocus() && isPaneVisible(paneId),
      ),
    })
    return true
  }
  const kitty = new KittyNotificationAssembler()
  const oscNotify9 = term.parser.registerOscHandler(9, (data) =>
    notifyFromTerminal(parseOsc9(data)),
  )
  const oscNotify777 = term.parser.registerOscHandler(777, (data) =>
    notifyFromTerminal(parseOsc777(data)),
  )
  const oscNotify99 = term.parser.registerOscHandler(99, (data) => {
    const chunk = parseOsc99(data, decodeBase64Utf8)
    return notifyFromTerminal(chunk ? kitty.push(chunk) : null)
  })
  const removePrimarySelection = installPrimarySelection(host, term, {
    enabled: () => isLinux && useSettingsStore.getState().terminal.primarySelection,
    writePrimary: (text) => window.ostia.window.writePrimarySelection(text),
  })
  const oscClipboard = registerOsc52(term, {
    enabled: () => useSettingsStore.getState().terminal.osc52Write,
    replaying: () => session.replaying,
    write: (text) => navigator.clipboard.writeText(text),
  })
  const copySelection = term.onSelectionChange(() => {
    useLiveSelectionStore
      .getState()
      .report(
        workspaceIdRef.current,
        paneId,
        { kind: 'terminal' },
        tail(term.getSelection(), CHAT_CONTEXT_TEXT_MAX),
      )
    if (!useSettingsStore.getState().behavior.copyOnSelect || !term.hasSelection()) return
    void navigator.clipboard.writeText(term.getSelection())
  })
  const titles = createTitleCommitter((title) =>
    commitProgramTitle(workspaceIdRef.current, paneId, title),
  )
  const titleChange = term.onTitleChange((raw) => {
    const title = terminalTitle(raw)
    if (title) titles.push(title)
  })
  const allowBellSound = createBellThrottle()
  const bellFlash = createBellFlash(host.closest<HTMLElement>('.terminal-stack') ?? host)
  const bell = term.onBell(() => {
    if (session.replaying) return
    const now = Date.now()
    const notifications = useSettingsStore.getState().notifications
    bellFlash.flash({
      enabled: notifications.visualBell && isPaneVisible(paneId),
      durationMs: notifications.visualBellMs,
      easing: notifications.visualBellEasing,
      color: term.options.theme?.foreground,
      reducedMotion: reducedMotionNow(),
      now,
    })
    const act = bellActions(notifications.bell, isPaneViewed(paneId))
    if (act.sound && allowBellSound(now)) window.ostia.window.beep()
    if (act.attention) useAttentionStore.getState().dispatch(paneId, { type: 'bell', at: now })
  })

  return () => {
    oscNotify9.dispose()
    oscNotify777.dispose()
    oscNotify99.dispose()
    oscClipboard.dispose()
    removePrimarySelection()
    bell.dispose()
    bellFlash.dispose()
    copySelection.dispose()
    useLiveSelectionStore.getState().clear(paneId)
    titleChange.dispose()
    titles.cancel()
  }
}

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}
