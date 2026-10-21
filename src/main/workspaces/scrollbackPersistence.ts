import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import type { Redactor } from '../privacy/redaction'
import { createScrollbackRedactor } from '../privacy/redaction'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { QuitTrace } from '../windows/quitPlan'
import type { WindowBroker } from '../windows/windowBroker'
import { pendingRestoredScrollback, saveScrollback, scrollbackToSave } from './savedScrollback'

interface ScrollbackPersistenceDeps {
  redactor: Redactor
  services: {
    broker: WindowBroker | null
  }
  ptys: Map<string, PtyEntry>
  isScratchPane: (paneId: string) => boolean
  quit: {
    savingScrollbackForQuit: boolean
    scrollbackSavedForQuit: boolean
  }
  quitTrace: QuitTrace
}

export type ScrollbackPersistence = ReturnType<typeof createScrollbackPersistence>

export function createScrollbackPersistence({
  redactor,
  services,
  ptys,
  isScratchPane,
  quit,
  quitTrace,
}: ScrollbackPersistenceDeps) {
  const redactScrollback = createScrollbackRedactor(redactor)
  let scrollbackSaves: Promise<void> = Promise.resolve()

  function persistScrollback(): Promise<void> {
    if (services.broker && !services.broker.persisting) return scrollbackSaves
    let toSave: Record<string, string>
    try {
      const byPane = pendingRestoredScrollback()
      for (const [paneId, entry] of ptys) byPane[paneId] = entry.mirror.serialize()
      toSave = scrollbackToSave(byPane, isScratchPane)
    } catch (err) {
      console.error('[workspace] scrollback save failed', err)
      return scrollbackSaves
    }
    scrollbackSaves = scrollbackSaves
      .then(async () => {
        const redacted = await redactScrollback(toSave)
        if (quit.savingScrollbackForQuit && !quit.scrollbackSavedForQuit)
          quitTrace.stage('scrollback-redacted')
        if (services.broker && !services.broker.persisting) return
        await saveScrollback(redacted)
      })
      .catch((err: unknown) => console.error('[workspace] scrollback save failed', err))
    return scrollbackSaves
  }

  const SCROLLBACK_AUTOSAVE_MS =
    process.env.NODE_ENV === 'test' && Number(readEnv('TEST_SCROLLBACK_AUTOSAVE_MS')) > 0
      ? Number(readEnv('TEST_SCROLLBACK_AUTOSAVE_MS'))
      : 5000
  const STREAMING_SAVE_GAP_MS = SCROLLBACK_AUTOSAVE_MS * 3
  const STREAMING_AFTER_TICKS = 2
  let lastScrollbackSignature = ''
  let previousSignature = ''
  let changeStreak = 0
  let lastAutosaveAt = Number.NEGATIVE_INFINITY

  function autosaveScrollback(): void {
    if (quit.savingScrollbackForQuit) return
    let signature = ''
    for (const [paneId, entry] of ptys) signature += `${paneId}:${entry.mirror.revision};`
    signature += `pending:${Object.keys(pendingRestoredScrollback()).length}`
    changeStreak = signature === previousSignature ? 0 : changeStreak + 1
    previousSignature = signature
    if (signature === lastScrollbackSignature) return
    const now = Date.now()
    if (changeStreak > STREAMING_AFTER_TICKS && now - lastAutosaveAt < STREAMING_SAVE_GAP_MS) return
    lastScrollbackSignature = signature
    lastAutosaveAt = now
    void persistScrollback()
  }

  return { persistScrollback, SCROLLBACK_AUTOSAVE_MS, autosaveScrollback }
}
