import { type PickCapture, type PickSendResult, reportReference } from '@shared/pick'
import { type SelectionCapture, type SelectionSendError, selectionLabel } from '@shared/selection'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { canTypeInto } from './blockActions'
import { terminalFor } from './terminalHandles'
import { signalPane } from './workspaceActivity'

const AGENT_AT_PROMPT = new Set(['waiting', 'done'])
const ATTENTION_NOTE_MAX = 120

export function canInsertReference(paneId: string): boolean {
  if (!terminalFor(paneId)) return false
  if (canTypeInto(paneId)) return true
  const running = useBlocksStore.getState().running[paneId] !== undefined
  const state = useAttentionStore.getState().byPane[paneId]?.state
  return running && state !== undefined && AGENT_AT_PROMPT.has(state)
}

export function insertPathReference(targetPaneId: string, path: string): boolean {
  const term = terminalFor(targetPaneId)
  if (!term || !canInsertReference(targetPaneId)) return false
  term.paste(reportReference(path))
  return true
}

async function deliverReport(
  targetPaneId: string,
  path: string,
  note: string,
  fallback: string,
): Promise<boolean> {
  const inserted = insertPathReference(targetPaneId, path)
  if (!inserted) {
    await navigator.clipboard?.writeText(reportReference(path).trim()).catch(() => undefined)
  }
  const summary = note.trim().replace(/\s+/g, ' ').slice(0, ATTENTION_NOTE_MAX)
  signalPane(targetPaneId, {
    type: 'set',
    state: 'working',
    message: summary || fallback,
    at: Date.now(),
  })
  return inserted
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
  const inserted = await deliverReport(
    opts.targetPaneId,
    res.path,
    opts.note,
    opts.capture.selector,
  )
  return { ok: true, path: res.path, inserted }
}

export type SendSelectionOutcome =
  | { ok: true; path: string; imagePath: string | null; inserted: boolean }
  | { ok: false; error: SelectionSendError }

export async function sendSelectionToPane(opts: {
  capture: SelectionCapture
  image?: Uint8Array
  sourcePaneId: string
  targetPaneId: string
  note: string
}): Promise<SendSelectionOutcome> {
  const res = await window.pine.selection.send({
    capture: opts.capture,
    ...(opts.image ? { image: opts.image } : {}),
    sourcePaneId: opts.sourcePaneId,
    targetPaneId: opts.targetPaneId,
    note: opts.note,
  })
  if (!res.ok) return res
  const inserted = await deliverReport(
    opts.targetPaneId,
    res.path,
    opts.note,
    selectionLabel(opts.capture),
  )
  return { ok: true, path: res.path, imagePath: res.imagePath, inserted }
}
