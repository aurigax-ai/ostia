import type { ElectronApplication } from './test'

export interface GuestMatch {
  viewType: string
  name?: string
}

export async function viewerGuestRun(
  app: ElectronApplication,
  match: GuestMatch,
  script: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { wanted, code }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith('ostia-viewer://')) continue
        const meta = await contents
          .executeJavaScript('fetch("/~meta").then((r) => r.json())')
          .catch(() => null)
        if (meta?.viewType !== wanted.viewType) continue
        if (wanted.name !== undefined && meta.name !== wanted.name) continue
        return contents.executeJavaScript(code).catch(() => null)
      }
      return null
    },
    { wanted: match, code: script },
  )
}

export async function viewerGuestText(
  app: ElectronApplication,
  match: GuestMatch,
): Promise<string> {
  return String((await viewerGuestRun(app, match, 'document.body.innerText')) ?? '')
}

export interface GuestPoint {
  x: number
  y: number
}

export async function viewerGuestDrag(
  app: ElectronApplication,
  match: GuestMatch,
  from: GuestPoint,
  to: GuestPoint,
): Promise<boolean> {
  return app.evaluate(
    async ({ webContents }, { wanted, start, end }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith('ostia-viewer://')) continue
        const meta = await contents
          .executeJavaScript('fetch("/~meta").then((r) => r.json())')
          .catch(() => null)
        if (meta?.viewType !== wanted.viewType) continue
        if (wanted.name !== undefined && meta.name !== wanted.name) continue
        const held = ['leftbuttondown' as const]
        contents.sendInputEvent({ type: 'mouseMove', x: start.x, y: start.y })
        contents.sendInputEvent({
          type: 'mouseDown',
          x: start.x,
          y: start.y,
          button: 'left',
          clickCount: 1,
        })
        contents.sendInputEvent({
          type: 'mouseMove',
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2,
          modifiers: held,
        })
        contents.sendInputEvent({ type: 'mouseMove', x: end.x, y: end.y, modifiers: held })
        contents.sendInputEvent({
          type: 'mouseUp',
          x: end.x,
          y: end.y,
          button: 'left',
          clickCount: 1,
        })
        return true
      }
      return false
    },
    { wanted: match, start: from, end: to },
  )
}
