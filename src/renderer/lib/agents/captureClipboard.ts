import { needsImage, type SelectionCapture } from '@shared/browser/selection'
import type { ClipboardCapture } from '@shared/keyboard/clipboardCapture'

export function selectionClipboard(
  capture: SelectionCapture,
  image: Uint8Array | undefined,
): ClipboardCapture | null {
  if (needsImage(capture)) return image ? { png: image } : null
  return 'text' in capture ? { text: capture.text } : null
}
