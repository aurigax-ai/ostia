import type {
  AssistAvailability,
  AssistPoint,
  AssistProviderInfo,
  AssistRequests,
  AssistResponse,
} from '@shared/assist'
import { create } from 'zustand'

interface AssistState {
  availability: AssistAvailability
  setAvailability: (availability: AssistAvailability) => void
}

export const useAssistStore = create<AssistState>((set) => ({
  availability: {},
  setAvailability: (availability) => set({ availability }),
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
  const off = window.pine?.assist?.onAvailability?.(apply) ?? (() => {})
  void window.pine?.assist
    ?.availability?.()
    .then(apply)
    .catch(() => {})
  return off
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
