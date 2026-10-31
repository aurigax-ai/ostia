import type { PickBox } from '@shared/browser/pick'
import { create } from 'zustand'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { currentDict, fmt } from '@/lib/app/useDict'
import type { BarAnchor } from './barAnchor'

export interface CaptureHighlight {
  rect: PickBox
  sized: boolean
}

export type CaptureResult = { ok: true; label: string } | { ok: false; error: string }

type CaptureSendOutcome = { ok: true; inserted: boolean } | { ok: false; error: string }

export type CloseReason =
  | 'escape'
  | 'outside'
  | 'scroll'
  | 'key'
  | 'guest-focus'
  | 'copied'
  | 'sent'
  | 'cancel'
  | 'hidden'
  | 'replaced'
  | 'source-gone'

export interface CaptureAdapter {
  anchor: BarAnchor | null
  takeFocus: boolean
  highlight: CaptureHighlight | null
  copy: () => Promise<CaptureResult>
  send: (target: PickTarget, note: string) => Promise<CaptureSendOutcome>
  clear: (reason: CloseReason) => void
}

export interface OpenCapture {
  key: number
  adapter: CaptureAdapter
  sendRequest: number
  pending: boolean
  error: string | null
}

export type CaptureChipTone = 'ok' | 'warn'

export interface CaptureChipState {
  id: number
  label: string
  tone: CaptureChipTone
}

interface CaptureState {
  open: Record<string, OpenCapture>
  status: Record<string, string>
  chip: Record<string, CaptureChipState>
}

const STATUS_MS = 6000
export const CHIP_MS = 2000

export const useCaptureStore = create<CaptureState>(() => ({ open: {}, status: {}, chip: {} }))

const openers = new Map<string, Array<() => void>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const chipTimers = new Map<string, ReturnType<typeof setTimeout>>()
let counter = 0

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record
  return rest
}

function patch(paneId: string, change: Partial<OpenCapture>): void {
  useCaptureStore.setState((state) => {
    const current = state.open[paneId]
    return current ? { open: { ...state.open, [paneId]: { ...current, ...change } } } : state
  })
}

export function setCaptureStatus(paneId: string, text: string | null): void {
  clearTimeout(timers.get(paneId))
  timers.delete(paneId)
  useCaptureStore.setState((state) => ({
    status: text === null ? without(state.status, paneId) : { ...state.status, [paneId]: text },
  }))
  if (text !== null)
    timers.set(
      paneId,
      setTimeout(() => setCaptureStatus(paneId, null), STATUS_MS),
    )
}

function setCaptureChip(paneId: string, label: string | null, tone: CaptureChipTone = 'ok'): void {
  clearTimeout(chipTimers.get(paneId))
  chipTimers.delete(paneId)
  counter += 1
  const id = counter
  useCaptureStore.setState((state) => ({
    chip:
      label === null
        ? without(state.chip, paneId)
        : { ...state.chip, [paneId]: { id, label, tone } },
  }))
  if (label !== null)
    chipTimers.set(
      paneId,
      setTimeout(() => setCaptureChip(paneId, null), CHIP_MS),
    )
}

export function closeCapture(paneId: string, reason: CloseReason): void {
  const current = useCaptureStore.getState().open[paneId]
  if (!current) return
  useCaptureStore.setState((state) => ({ open: without(state.open, paneId) }))
  current.adapter.clear(reason)
}

export function showCaptureChip(paneId: string, label: string, tone: CaptureChipTone): void {
  setCaptureChip(paneId, label, tone)
}

export function confirmCapture(paneId: string, label: string, reason: 'copied' | 'sent'): void {
  setCaptureChip(paneId, label)
  closeCapture(paneId, reason)
}

export function openCapture(paneId: string, adapter: CaptureAdapter): void {
  closeCapture(paneId, 'replaced')
  setCaptureStatus(paneId, null)
  setCaptureChip(paneId, null)
  counter += 1
  useCaptureStore.setState((state) => ({
    open: {
      ...state.open,
      [paneId]: { key: counter, adapter, sendRequest: 0, pending: false, error: null },
    },
  }))
}

export function updateCapture(paneId: string, adapter: CaptureAdapter): void {
  patch(paneId, { adapter })
}

async function settle<T>(
  paneId: string,
  run: (current: OpenCapture) => Promise<T>,
): Promise<T | null> {
  const current = useCaptureStore.getState().open[paneId]
  if (!current || current.pending) return null
  patch(paneId, { pending: true, error: null })
  try {
    const result = await run(current)
    return useCaptureStore.getState().open[paneId] === undefined ? null : result
  } catch (e) {
    patch(paneId, { pending: false, error: messageOf(e) })
    return null
  }
}

export function copyCapture(paneId: string): Promise<void> | null {
  if (!useCaptureStore.getState().open[paneId]) return null
  return settle(paneId, (current) => current.adapter.copy()).then((result) => {
    if (!result) return
    if (result.ok) confirmCapture(paneId, result.label, 'copied')
    else patch(paneId, { pending: false, error: result.error })
  })
}

export function sendCapture(paneId: string, target: PickTarget, note: string): Promise<void> {
  return settle(paneId, (current) => current.adapter.send(target, note)).then((result) => {
    if (!result) return
    const d = currentDict()
    if (result.ok) {
      const sent = result.inserted ? d.send.sentInserted : d.send.sentCopied
      confirmCapture(paneId, fmt(sent, { pane: target.title }), 'sent')
    } else
      patch(paneId, { pending: false, error: fmt(d.send.sendFailed, { reason: result.error }) })
  })
}

export function showSendMenu(paneId: string): void {
  const current = useCaptureStore.getState().open[paneId]
  if (current) patch(paneId, { sendRequest: current.sendRequest + 1 })
}

export function registerCaptureOpener(paneId: string, open: () => void): () => void {
  openers.set(paneId, [...(openers.get(paneId) ?? []), open])
  return () => {
    const rest = (openers.get(paneId) ?? []).filter((held) => held !== open)
    if (rest.length > 0) openers.set(paneId, rest)
    else openers.delete(paneId)
  }
}

export function triggerCapture(paneId: string): boolean {
  if (useCaptureStore.getState().open[paneId]) {
    showSendMenu(paneId)
    return true
  }
  const open = openers.get(paneId)?.at(-1)
  if (!open) return false
  open()
  return true
}
