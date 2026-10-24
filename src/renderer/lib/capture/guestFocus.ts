import { closeCapture } from './captureSession'

export function closeOnGuestFocus(paneId: string, guest: HTMLElement): () => void {
  const onBlur = (): void => {
    if (document.activeElement === guest) closeCapture(paneId, 'guest-focus')
  }
  window.addEventListener('blur', onBlur)
  return () => window.removeEventListener('blur', onBlur)
}
