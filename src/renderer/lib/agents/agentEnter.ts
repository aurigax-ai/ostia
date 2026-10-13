export const ENTER_AFTER_PASTE_MS = 60

export function pressEnterAfterPaste(paneId: string, stillAllowed: () => boolean): void {
  setTimeout(() => {
    if (stillAllowed()) window.ostia.pty.write(paneId, '\r')
  }, ENTER_AFTER_PASTE_MS)
}
