import type { ElectronApplication } from './test'

export type GuestPointer = { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number }

export async function viewerGuestInput(
  app: ElectronApplication,
  match: { viewType: string; name: string },
  pointer: GuestPointer[],
  keys: Array<{ keyCode: string; modifiers?: Array<'control'> }> = [],
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, { wanted, points, presses }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith('ostia-viewer://')) continue
        const meta = await contents
          .executeJavaScript('fetch("/~meta").then((r) => r.json())')
          .catch(() => null)
        if (meta?.viewType !== wanted.viewType || meta.name !== wanted.name) continue
        for (const point of points) {
          contents.sendInputEvent({ ...point, button: 'left', clickCount: 1 })
        }
        for (const press of presses) {
          const modifiers = press.modifiers ?? []
          contents.sendInputEvent({ type: 'keyDown', keyCode: press.keyCode, modifiers })
          contents.sendInputEvent({ type: 'keyUp', keyCode: press.keyCode, modifiers })
        }
        return
      }
      throw new Error('viewer guest missing')
    },
    { wanted: match, points: pointer, presses: keys },
  )
}

export function clickAt(x: number, y: number): GuestPointer[] {
  return [
    { type: 'mouseMove', x, y },
    { type: 'mouseDown', x, y },
    { type: 'mouseUp', x, y },
  ]
}

export function dragBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
): GuestPointer[] {
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  return [
    { type: 'mouseMove', ...from },
    { type: 'mouseDown', ...from },
    { type: 'mouseMove', ...middle },
    { type: 'mouseMove', ...to },
    { type: 'mouseUp', ...to },
  ]
}
