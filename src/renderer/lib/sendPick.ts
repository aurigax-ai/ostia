import { type PickCapture, type PickSendResult, reportReference } from '@shared/pick'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { canTypeInto } from './blockActions'
import { signalPane } from './sessionActivity'
import { terminalFor } from './terminalHandles'

const AGENT_AT_PROMPT = new Set(['waiting', 'done'])
const ATTENTION_NOTE_MAX = 120

export function canInsertReference(paneId: string): boolean {
  if (!terminalFor(paneId)) return false
  if (canTypeInto(paneId)) return true
  const running = useBlocksStore.getState().running[paneId] !== undefined
  const state = useAttentionStore.getState().byPane[paneId]?.state
  return running && state !== undefined && AGENT_AT_PROMPT.has(state)
}

export type SendPickOutcome =
  | { ok: true; path: string; inserted: boolean }
  | { ok: false; error: Extract<PickSendResult, { ok: false }>['error'] }

export async function sendPickToPane(opts: {
  capture: PickCapture
  sourcePaneId: string
  targetPaneId: string
  note: string
}): Promise<SendPickOutcome> {
  const res = await window.pine.browser.pickSend({
    captureId: opts.capture.id,
    sourcePaneId: opts.sourcePaneId,
    targetPaneId: opts.targetPaneId,
    note: opts.note,
  })
  if (!res.ok) return res
  const reference = reportReference(res.path)
  const term = terminalFor(opts.targetPaneId)
  const inserted = Boolean(term) && canInsertReference(opts.targetPaneId)
  if (inserted) term?.paste(reference)
  else await navigator.clipboard?.writeText(reference.trim()).catch(() => undefined)
  const summary = opts.note.trim().replace(/\s+/g, ' ').slice(0, ATTENTION_NOTE_MAX)
  signalPane(opts.targetPaneId, {
    type: 'set',
    state: 'working',
    message: summary || opts.capture.selector,
    at: Date.now(),
  })
  return { ok: true, path: res.path, inserted }
}
