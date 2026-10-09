import { signalPane } from '@/lib/attention/workspaceActivity'
import { canTypeInto } from '@/lib/terminal/blockActions'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useAttentionStore } from '@/stores/attentionStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  type PickCapture,
  type PickSendResult,
  captureReferences,
  reportReference,
} from '@shared/browser/pick'
import type { RegionCapture } from '@shared/browser/regionCapture'
import {
  type SelectionCapture,
  type SelectionSendError,
  selectionLabel,
} from '@shared/browser/selection'
import type { ReferenceInsert } from '@shared/types'
import { pressEnterAfterPaste } from './agentEnter'
import { runningAgentOf } from './paneAgent'

const AGENT_AT_PROMPT = new Set(['waiting', 'done'])
const ATTENTION_NOTE_MAX = 120

export function canInsertReference(paneId: string): boolean {
  if (!terminalFor(paneId)) return false
  if (canTypeInto(paneId)) return true
  if (useBlocksStore.getState().running[paneId] === undefined) return false
  if (runningAgentOf(paneId)) return true
  const state = useAttentionStore.getState().byPane[paneId]?.state
  return state !== undefined && AGENT_AT_PROMPT.has(state)
}

function submitsReference(paneId: string): boolean {
  return (
    useSettingsStore.getState().agents.autoSendReferences &&
    runningAgentOf(paneId) !== null &&
    canInsertReference(paneId)
  )
}

export interface ReferenceTarget {
  paneId: string
  via?: string
}

export interface ReferenceSend {
  note?: string
  pointedByHuman?: boolean
}

function insertReference(paneId: string, text: string, pointedByHuman: boolean): boolean {
  const term = terminalFor(paneId)
  if (!term || !canInsertReference(paneId)) return false
  term.paste(text)
  if (pointedByHuman && submitsReference(paneId)) {
    pressEnterAfterPaste(paneId, () => submitsReference(paneId))
  }
  return true
}

function markWorking(paneId: string, message: string): void {
  signalPane(paneId, { type: 'set', state: 'working', message, at: Date.now() })
}

export function receiveReference(insert: ReferenceInsert): boolean {
  const inserted = insertReference(insert.paneId, insert.text, insert.pointedByHuman === true)
  if (insert.note) markWorking(insert.paneId, insert.note)
  return inserted
}

export async function sendReference(
  target: ReferenceTarget,
  text: string,
  { note, pointedByHuman = false }: ReferenceSend = {},
): Promise<boolean> {
  if (target.via === undefined) {
    const inserted = insertReference(target.paneId, text, pointedByHuman)
    if (note !== undefined) markWorking(target.paneId, note)
    return inserted
  }
  return window.ostia.windows
    .insertReference({
      workspaceId: target.via,
      paneId: target.paneId,
      text,
      ...(note ? { note } : {}),
      ...(pointedByHuman ? { pointedByHuman } : {}),
    })
    .catch(() => false)
}

export function insertPathReference(target: ReferenceTarget, path: string): Promise<boolean> {
  return sendReference(target, reportReference(path))
}

async function deliverReport(
  target: ReferenceTarget,
  references: string,
  note: string,
  fallback: string,
  pointedByHuman = true,
): Promise<boolean> {
  const summary = note.trim().replace(/\s+/g, ' ').slice(0, ATTENTION_NOTE_MAX)
  const inserted = await sendReference(target, references, {
    note: summary || fallback,
    pointedByHuman,
  })
  if (!inserted) {
    await navigator.clipboard?.writeText(references.trim()).catch(() => undefined)
  }
  return inserted
}

export type SendPickOutcome =
  | { ok: true; path: string; inserted: boolean }
  | { ok: false; error: Extract<PickSendResult, { ok: false }>['error'] }

interface CaptureSendOptions {
  sourcePaneId: string
  targetPaneId: string
  via?: string
  note: string
  attachImage: boolean
}

async function deliverCapture(
  res: PickSendResult,
  opts: CaptureSendOptions,
  fallback: string,
): Promise<SendPickOutcome> {
  if (!res.ok) return res
  const inserted = await deliverReport(
    { paneId: opts.targetPaneId, via: opts.via },
    captureReferences(res.path, opts.attachImage ? res.imagePath : null),
    opts.note,
    fallback,
  )
  return { ok: true, path: res.path, inserted }
}

export async function sendPickToPane(
  opts: CaptureSendOptions & { capture: PickCapture },
): Promise<SendPickOutcome> {
  const res = await window.ostia.browser.pickSend({
    captureId: opts.capture.id,
    sourcePaneId: opts.sourcePaneId,
    targetPaneId: opts.targetPaneId,
    note: opts.note,
  })
  return deliverCapture(res, opts, opts.capture.selector)
}

export async function sendRegionToPane(
  opts: CaptureSendOptions & { capture: RegionCapture },
): Promise<SendPickOutcome> {
  const res = await window.ostia.browser.regionSend({
    captureId: opts.capture.id,
    sourcePaneId: opts.sourcePaneId,
    targetPaneId: opts.targetPaneId,
    note: opts.note,
  })
  return deliverCapture(res, opts, opts.capture.title || opts.capture.url)
}

export type SendSelectionOutcome =
  | { ok: true; path: string; imagePath: string | null; inserted: boolean }
  | { ok: false; error: SelectionSendError }

export async function sendSelectionToPane(opts: {
  capture: SelectionCapture
  image?: Uint8Array
  sourcePaneId: string
  targetPaneId: string
  via?: string
  note: string
}): Promise<SendSelectionOutcome> {
  const res = await window.ostia.selection.send({
    capture: opts.capture,
    ...(opts.image ? { image: opts.image } : {}),
    sourcePaneId: opts.sourcePaneId,
    targetPaneId: opts.targetPaneId,
    note: opts.note,
  })
  if (!res.ok) return res
  const inserted = await deliverReport(
    { paneId: opts.targetPaneId, via: opts.via },
    reportReference(res.path),
    opts.note,
    selectionLabel(opts.capture),
    opts.capture.kind !== 'preview-error',
  )
  return { ok: true, path: res.path, imagePath: res.imagePath, inserted }
}
