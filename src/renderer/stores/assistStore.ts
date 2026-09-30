import type {
  AssistAvailability,
  AssistExtensionState,
  AssistPoint,
  AssistProviderInfo,
  AssistRequests,
  AssistResponse,
} from '@shared/assist'
import { create } from 'zustand'

interface AssistState {
  availability: AssistAvailability
  overview: AssistExtensionState[]
  setAvailability: (availability: AssistAvailability) => void
  setOverview: (overview: AssistExtensionState[]) => void
}

export const useAssistStore = create<AssistState>((set) => ({
  availability: {},
  overview: [],
  setAvailability: (availability) => set({ availability }),
  setOverview: (overview) => set({ overview }),
}))

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
  const off = window.pine?.assist?.onAvailability?.(apply) ?? (() => {})
  const offOverview = window.pine?.assist?.onOverview?.(applyOverview) ?? (() => {})
  void window.pine?.assist
    ?.availability?.()
    .then(apply)
    .catch(() => {})
  void window.pine?.assist
    ?.overview?.()
    .then(applyOverview)
    .catch(() => {})
  return () => {
    off()
    offOverview()
  }
}

let requestSeq = 0

export function nextAssistRequestId(): string {
  requestSeq += 1
  return `r${Date.now().toString(36)}-${requestSeq}`
}

export interface AssistCallOptions {
  signal?: AbortSignal
  onChunk?: (text: string) => void
}

export async function assistRequest<P extends AssistPoint>(
  point: P,
  input: AssistRequests[P],
  opts: AssistCallOptions = {},
): Promise<AssistResponse<P>> {
  if (opts.signal?.aborted) return { ok: false, error: 'cancelled' }
  const requestId = nextAssistRequestId()
  const offChunk = opts.onChunk
    ? window.pine.assist.onChunk((chunk) => {
        if (chunk.requestId === requestId) opts.onChunk?.(chunk.text)
      })
    : () => {}
  const onAbort = (): void => window.pine.assist.cancel(requestId)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await window.pine.assist.request(point, requestId, input)
    return opts.signal?.aborted ? { ok: false, error: 'cancelled' } : res
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    offChunk()
  }
}
