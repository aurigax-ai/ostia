import { BrowserWindow, Menu, type WebContents, clipboard } from 'electron'
import { contextMenuTemplate } from './contextMenuTemplate'

export function attachContextMenu(contents: WebContents, navigation: boolean): void {
  contents.on('context-menu', (_e, params) => {
    const history = contents.navigationHistory
    const template = contextMenuTemplate(
      params,
      { navigation, canGoBack: history.canGoBack(), canGoForward: history.canGoForward() },
      {
        copyLink: (url) => {
          clipboard.writeText(url).catch(() => undefined)
        },
        copyImage: (x, y) => contents.copyImageAt(x, y),
        back: () => history.goBack(),
        forward: () => history.goForward(),
        reload: () => contents.reload(),
      },
    )
    if (template.length === 0) return
    const owner = contents.getType() === 'webview' ? contents.hostWebContents : contents
    const window = owner ? BrowserWindow.fromWebContents(owner) : null
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
  })
}
