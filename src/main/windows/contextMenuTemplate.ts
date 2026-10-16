import type { ContextMenuParams, MenuItemConstructorOptions, Referrer } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { isTabUrl } from '../../shared/browser/linkTabs'

export type ContextMenuText = Dict['native']['contextMenu']

export type ContextParams = Pick<
  ContextMenuParams,
  | 'isEditable'
  | 'editFlags'
  | 'selectionText'
  | 'linkURL'
  | 'mediaType'
  | 'hasImageContents'
  | 'referrerPolicy'
  | 'frameURL'
  | 'pageURL'
  | 'x'
  | 'y'
>

export interface ContextPage {
  navigation: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface ContextActions {
  openLinkInNewTab?: (url: string, referrer: Referrer) => void
  copyLink: (url: string) => void
  copyImage: (x: number, y: number) => void
  back: () => void
  forward: () => void
  reload: () => void
}

function linkReferrer(params: ContextParams): Referrer {
  return { url: params.frameURL || params.pageURL, policy: params.referrerPolicy.policy }
}

export function contextMenuTemplate(
  params: ContextParams,
  page: ContextPage,
  actions: ContextActions,
  text: ContextMenuText,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const group = (group: MenuItemConstructorOptions[]): void => {
    if (group.length === 0) return
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(...group)
  }
  const selected = params.selectionText.trim().length > 0
  const image = params.mediaType === 'image' && params.hasImageContents
  if (params.isEditable) {
    const flags = params.editFlags
    group([
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
    ])
    group([
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { role: 'selectAll', enabled: flags.canSelectAll },
    ])
  } else if (selected) {
    group([{ role: 'copy' }])
  }
  if (params.linkURL) {
    const link = params.linkURL
    const open = actions.openLinkInNewTab
    group([
      ...(open && isTabUrl(link)
        ? [{ label: text.openLinkInNewTab, click: () => open(link, linkReferrer(params)) }]
        : []),
      { label: text.copyLink, click: () => actions.copyLink(link) },
    ])
  }
  if (image) {
    group([{ label: text.copyImage, click: () => actions.copyImage(params.x, params.y) }])
  }
  if (page.navigation && !params.isEditable && !selected && !params.linkURL && !image) {
    group([
      { label: text.back, enabled: page.canGoBack, click: actions.back },
      { label: text.forward, enabled: page.canGoForward, click: actions.forward },
      { label: text.reload, click: actions.reload },
    ])
  }
  return items
}
