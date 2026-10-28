import { currentDict } from '@/lib/app/useDict'
import { confirmCapture, useCaptureStore } from './captureSession'

function confirmCopied(paneId: string): void {
  confirmCapture(paneId, currentDict().send.copied, 'copied')
}

export async function copyTextConfirmed(paneId: string, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return false
  }
  confirmCopied(paneId)
  return true
}

export function confirmNativeCopy(paneId: string): void {
  if (!useCaptureStore.getState().open[paneId]) confirmCopied(paneId)
}
