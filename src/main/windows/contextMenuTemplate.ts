import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

export type ContextParams = Pick<
  ContextMenuParams,
  | 'isEditable'
  | 'editFlags'
  | 'selectionText'
  | 'linkURL'
  | 'mediaType'
  | 'hasImageContents'
  | 'x'
  | 'y'
>

export interface ContextPage {
  navigation: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface ContextActions {
  copyLink: (url: string) => void
  copyImage: (x: number, y: number) => void
  back: () => void
  forward: () => void
  reload: () => void
}

export function contextMenuTemplate(
  params: ContextParams,
  page: ContextPage,
  actions: ContextActions,
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
    group([{ label: 'Copy Link Address', click: () => actions.copyLink(params.linkURL) }])
  }
  if (image) {
    group([{ label: 'Copy Image', click: () => actions.copyImage(params.x, params.y) }])
  }
  if (page.navigation && !params.isEditable && !selected && !params.linkURL && !image) {
    group([
      { label: 'Back', enabled: page.canGoBack, click: actions.back },
      { label: 'Forward', enabled: page.canGoForward, click: actions.forward },
      { label: 'Reload', click: actions.reload },
    ])
  }
  return items
}
