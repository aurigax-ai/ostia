import type { WebviewTag } from 'electron'

export function guestReached(webview: HTMLElement): boolean {
  try {
    ;(webview as unknown as WebviewTag).getWebContentsId()
    return true
  } catch {
    return false
  }
}
