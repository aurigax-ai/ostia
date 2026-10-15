import type { ElectronApplication } from './test'

export async function viewerGuestText(app: ElectronApplication, viewType: string): Promise<string> {
  return app.evaluate(async ({ webContents }, wanted) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().startsWith('ostia-viewer://')) continue
      const shown = await contents.executeJavaScript('document.body.innerText').catch(() => '')
      const type = await contents
        .executeJavaScript('fetch("/~meta").then((r) => r.json()).then((m) => m.viewType)')
        .catch(() => '')
      if (type === wanted) return String(shown)
    }
    return ''
  }, viewType)
}
