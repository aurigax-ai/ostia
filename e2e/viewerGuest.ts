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
