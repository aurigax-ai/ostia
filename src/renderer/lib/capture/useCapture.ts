import { type CaptureHighlight, type OpenCapture, useCaptureStore } from './captureSession'

export function useOpenCapture(paneId: string): OpenCapture | null {
  return useCaptureStore((state) => state.open[paneId] ?? null)
}

export function useCaptureStatus(paneId: string): string | null {
  return useCaptureStore((state) => state.status[paneId] ?? null)
}

export function useCaptureHighlight(paneId: string): CaptureHighlight | null {
  return useCaptureStore((state) => state.open[paneId]?.adapter.highlight ?? null)
}
