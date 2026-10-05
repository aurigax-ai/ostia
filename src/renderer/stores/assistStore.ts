import {
  type AssistAvailability,
  type AssistCatalog,
  type AssistExtensionState,
  type AssistModelChoice,
  type AssistModelRef,
  type AssistPoint,
  type AssistProviderInfo,
  type AssistRequests,
  type AssistResponse,
  EMPTY_ASSIST_CATALOG,
  choiceLabel,
  sameModelRef,
} from '@shared/assist'
import { useMemo } from 'react'
import { create } from 'zustand'

interface AssistState {
  availability: AssistAvailability
  overview: AssistExtensionState[]
  catalog: AssistCatalog
  setAvailability: (availability: AssistAvailability) => void
  setOverview: (overview: AssistExtensionState[]) => void
  setCatalog: (catalog: AssistCatalog) => void
}

export const useAssistStore = create<AssistState>((set) => ({
  availability: {},
  overview: [],
  catalog: EMPTY_ASSIST_CATALOG,
  setAvailability: (availability) => set({ availability }),
  setOverview: (overview) => set({ overview }),
  setCatalog: (catalog) => set({ catalog }),
}))

export function chatChoices(catalog: AssistCatalog): AssistModelChoice[] {
  return catalog.models.filter((choice) => choice.points.includes('chat'))
}

function chatModelIn(
  state: Pick<AssistState, 'availability' | 'catalog' | 'overview'>,
  wanted: AssistModelRef | null | undefined,
): AssistProviderInfo | null {
  const base = state.availability.chat ?? null
  if (!wanted || (base && sameModelRef(wanted, base.ref))) return base
  const choice = chatChoices(state.catalog).find((c) => sameModelRef(c.ref, wanted))
  if (!choice) return base
  const name = state.overview.find((o) => o.extId === choice.ref.extId)?.name ?? choice.group
  const info: AssistProviderInfo = {
    extId: choice.ref.extId,
    name,
    label: choiceLabel(choice),
    ref: choice.ref,
  }
  return choice.tools ? { ...info, tools: choice.tools } : info
}

export function chatModel(wanted: AssistModelRef | null | undefined): AssistProviderInfo | null {
  return chatModelIn(useAssistStore.getState(), wanted)
}

export function useChatModel(wanted: AssistModelRef | null | undefined): AssistProviderInfo | null {
  const availability = useAssistStore((s) => s.availability)
  const catalog = useAssistStore((s) => s.catalog)
  const overview = useAssistStore((s) => s.overview)
  return useMemo(
    () => chatModelIn({ availability, catalog, overview }, wanted),
    [availability, catalog, overview, wanted],
  )
}

export function useAssistProvider(point: AssistPoint): AssistProviderInfo | null {
  return useAssistStore((s) => s.availability[point] ?? null)
}

export function assistProvider(point: AssistPoint): AssistProviderInfo | null {
  return useAssistStore.getState().availability[point] ?? null
}

export function startAssistAvailability(): () => void {
  const apply = (availability: AssistAvailability): void =>
    useAssistStore.getState().setAvailability(availability)
  const applyOverview = (overview: AssistExtensionState[]): void =>
    useAssistStore.getState().setOverview(overview)
  const applyCatalog = (catalog: AssistCatalog): void =>
    useAssistStore.getState().setCatalog(catalog)
  const off = window.ostia?.assist?.onAvailability?.(apply) ?? (() => {})
  const offOverview = window.ostia?.assist?.onOverview?.(applyOverview) ?? (() => {})
  const offCatalog = window.ostia?.assist?.onCatalog?.(applyCatalog) ?? (() => {})
  void window.ostia?.assist
    ?.catalog?.()
    .then(applyCatalog)
    .catch(() => {})
  void window.ostia?.assist
    ?.availability?.()
    .then(apply)
    .catch(() => {})
  void window.ostia?.assist
    ?.overview?.()
    .then(applyOverview)
    .catch(() => {})
  return () => {
    off()
    offOverview()
    offCatalog()
  }
}

let requestSeq = 0
const CHUNK_CATCH_UP_MS = 3000

export function nextAssistRequestId(): string {
  requestSeq += 1
  return `r${Date.now().toString(36)}-${requestSeq}`
}

export interface AssistCallOptions {
  signal?: AbortSignal
  onChunk?: (text: string) => void
  model?: AssistModelRef
}

export async function assistRequest<P extends AssistPoint>(
  point: P,
  input: AssistRequests[P],
  opts: AssistCallOptions = {},
): Promise<AssistResponse<P>> {
  if (opts.signal?.aborted) return { ok: false, error: 'cancelled' }
  const requestId = nextAssistRequestId()
  let received = 0
  let caughtUp: (() => void) | null = null
  let expected = Number.POSITIVE_INFINITY
  const offChunk = opts.onChunk
    ? window.ostia.assist.onChunk((chunk) => {
        if (chunk.requestId !== requestId) return
        received += 1
        opts.onChunk?.(chunk.text)
        if (received >= expected) caughtUp?.()
      })
    : () => {}
  const onAbort = (): void => window.ostia.assist.cancel(requestId)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = opts.model
      ? await window.ostia.assist.request(point, requestId, input, opts.model)
      : await window.ostia.assist.request(point, requestId, input)
    if (opts.onChunk && res.chunks && received < res.chunks) {
      expected = res.chunks
      await new Promise<void>((resolve) => {
        caughtUp = resolve
        setTimeout(resolve, CHUNK_CATCH_UP_MS)
      })
    }
    return opts.signal?.aborted ? { ok: false, error: 'cancelled' } : res
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    offChunk()
  }
}
