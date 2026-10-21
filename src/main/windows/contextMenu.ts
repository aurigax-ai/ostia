import { BrowserWindow, clipboard, Menu, type WebContents } from 'electron'
import {
  type ContextActions,
  type ContextMenuText,
  contextMenuTemplate,
} from './contextMenuTemplate'

export function attachContextMenu(
  contents: WebContents,
  navigation: boolean,
  text: () => ContextMenuText,
  openLinkInNewTab?: ContextActions['openLinkInNewTab'],
): void {
  contents.on('context-menu', (_e, params) => {
    const history = contents.navigationHistory
    const template = contextMenuTemplate(
      params,
      { navigation, canGoBack: history.canGoBack(), canGoForward: history.canGoForward() },
      {
        openLinkInNewTab,
        copyLink: (url) => {
          clipboard.writeText(url).catch(() => undefined)
        },
        copyImage: (x, y) => contents.copyImageAt(x, y),
        back: () => history.goBack(),
        forward: () => history.goForward(),
        reload: () => contents.reload(),
      },
      text(),
    )
    if (template.length === 0) return
    const owner = contents.getType() === 'webview' ? contents.hostWebContents : contents
    const window = owner ? BrowserWindow.fromWebContents(owner) : null
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
  })
}
