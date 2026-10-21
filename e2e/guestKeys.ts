import { isMac } from './chords'
import type { ElectronApplication } from './test'

interface GuestKey {
  keyCode: string
  modifiers: string[]
}

const appMod = isMac ? ['meta'] : ['control', 'shift']

export const guestKeys: Record<'palette' | 'dashboard' | 'sendToAgent', GuestKey> = {
  sendToAgent: { keyCode: 'E', modifiers: isMac ? ['meta', 'shift'] : ['control', 'shift'] },
  palette: { keyCode: isMac ? 'K' : 'P', modifiers: appMod },
  dashboard: { keyCode: 'D', modifiers: isMac ? ['meta', 'shift'] : ['control', 'shift'] },
}

export async function pressInPage(app: ElectronApplication, key: GuestKey): Promise<void> {
  await app.evaluate(({ webContents }, k) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
    if (!guest) throw new Error('no page')
    for (const type of ['keyDown', 'keyUp'] as const) {
      guest.sendInputEvent({
        type,
        keyCode: k.keyCode,
        modifiers: k.modifiers as Electron.InputEvent['modifiers'],
      })
    }
  }, key)
}
