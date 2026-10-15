import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { createScrollbackRedactor } from '../privacy/redaction'
import type { Redactor } from '../privacy/redaction'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { QuitTrace } from '../windows/quitPlan'
import type { WindowBroker } from '../windows/windowBroker'
import { pendingRestoredScrollback, saveScrollback, scrollbackToSave } from './workspaceSnapshot'

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
  let lastScrollbackSignature = ''

  function autosaveScrollback(): void {
    if (quit.savingScrollbackForQuit) return
    let signature = ''
    for (const [paneId, entry] of ptys) signature += `${paneId}:${entry.mirror.revision};`
    signature += `pending:${Object.keys(pendingRestoredScrollback()).length}`
    if (signature === lastScrollbackSignature) return
    lastScrollbackSignature = signature
    void persistScrollback()
  }

  return { persistScrollback, SCROLLBACK_AUTOSAVE_MS, autosaveScrollback }
}
