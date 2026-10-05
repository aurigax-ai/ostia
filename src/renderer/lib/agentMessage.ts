import { runningAgent } from './paneAgent'
import { type HumanPastePlan, planHumanPaste } from './pasteGate'
import { canInsertReference } from './sendPick'
import { terminalFor } from './terminalHandles'

export const ENTER_AFTER_PASTE_MS = 60

export function planAgentMessage(text: string, warnOnRiskyPaste: boolean): HumanPastePlan {
  return planHumanPaste(text.trim(), warnOnRiskyPaste)
}

export function canMessageAgent(paneId: string): boolean {
  return runningAgent(paneId) !== null && canInsertReference(paneId)
}

export function sendToAgent(paneId: string, text: string): boolean {
  const term = terminalFor(paneId)
  if (!term || !text || !canMessageAgent(paneId)) return false
  term.paste(text)
  setTimeout(() => {
    if (canMessageAgent(paneId)) window.ostia.pty.write(paneId, '\r')
  }, ENTER_AFTER_PASTE_MS)
  return true
}
