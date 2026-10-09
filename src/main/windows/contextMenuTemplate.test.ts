import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { type ContextParams, contextMenuTemplate } from './contextMenuTemplate'

const popups: { items: MenuItemConstructorOptions[]; options: unknown }[] = []

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (owner: { window: unknown }) => owner.window },
  Menu: {
    buildFromTemplate: (items: MenuItemConstructorOptions[]) => ({
      popup: (options: unknown) => popups.push({ items, options }),
    }),
  },
  clipboard: { writeText: () => Promise.resolve() },
}))

const { attachContextMenu } = await import('./contextMenu')

const flags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
}

const params = (over: Partial<ContextParams> = {}): ContextParams => ({
  isEditable: false,
  editFlags: flags,
  selectionText: '',
  linkURL: '',
  mediaType: 'none',
  hasImageContents: false,
  x: 10,
  y: 20,
  ...over,
})

const appPage = { navigation: false, canGoBack: false, canGoForward: false }
const webPage = { navigation: true, canGoBack: true, canGoForward: false }

function actions() {
  return {
    copyLink: vi.fn(),
    copyImage: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
  }
}

const shape = (items: MenuItemConstructorOptions[]) =>
  items.map((i) =>
    i.type === 'separator' ? '-' : `${i.role ?? i.label}${i.enabled === false ? ' (off)' : ''}`,
  )

function fakeContents(type: string, window: unknown) {
  const handlers: ((event: unknown, params: ContextParams) => void)[] = []
  const contents = {
    window,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    getType: () => type,
    hostWebContents: { window: 'host window' },
    on: (_name: string, handler: (event: unknown, params: ContextParams) => void) => {
      handlers.push(handler)
    },
    rightClick: (over: Partial<ContextParams>) => {
      for (const handler of handlers) handler({}, params(over))
    },
  }
  return contents
}

describe('contextMenuTemplate', () => {
  it('offers edit actions in a text field, enabled by what the field can do', () => {
    const items = contextMenuTemplate(params({ isEditable: true }), appPage, actions())
    expect(shape(items)).toEqual([
      'undo (off)',
      'redo (off)',
      '-',
      'cut (off)',
      'copy (off)',
      'paste',
      'selectAll',
    ])
  })

  it('offers Copy for selected text outside a field, and nothing on a blank part of the app', () => {
    expect(
      shape(contextMenuTemplate(params({ selectionText: 'hello' }), appPage, actions())),
    ).toEqual(['copy'])
    expect(contextMenuTemplate(params({ selectionText: '  ' }), appPage, actions())).toEqual([])
  })

  it('copies a link address and an image', () => {
    const act = actions()
    const items = contextMenuTemplate(
      params({ linkURL: 'https://example.com/a', mediaType: 'image', hasImageContents: true }),
      webPage,
      act,
    )
    expect(shape(items)).toEqual(['Copy Link Address', '-', 'Copy Image'])
    items[0].click?.({} as never, undefined, {} as never)
    items[2].click?.({} as never, undefined, {} as never)
    expect(act.copyLink).toHaveBeenCalledWith('https://example.com/a')
    expect(act.copyImage).toHaveBeenCalledWith(10, 20)
  })

  it('offers Back, Forward and Reload on a blank part of a web page only', () => {
    const act = actions()
    const items = contextMenuTemplate(params(), webPage, act)
    expect(shape(items)).toEqual(['Back', 'Forward (off)', 'Reload'])
    items[0].click?.({} as never, undefined, {} as never)
    items[2].click?.({} as never, undefined, {} as never)
    expect(act.back).toHaveBeenCalled()
    expect(act.reload).toHaveBeenCalled()
    expect(shape(contextMenuTemplate(params({ isEditable: true }), webPage, act))).not.toContain(
      'Reload',
    )
    expect(shape(contextMenuTemplate(params({ selectionText: 'x' }), webPage, act))).toEqual([
      'copy',
    ])
  })

  it('right-click in a text field and on a web page shows the native menu', () => {
    popups.length = 0
    const app = fakeContents('window', 'app window')
    attachContextMenu(app as never, false)
    app.rightClick({ isEditable: true, editFlags: { ...flags, canCopy: true } })
    expect(popups.at(-1)?.items.map((i) => i.role)).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']),
    )
    expect(popups.at(-1)?.options).toEqual({ window: 'app window' })

    const page = fakeContents('webview', null)
    attachContextMenu(page as never, true)
    page.rightClick({})
    expect(popups).toHaveLength(2)
    expect(popups[1].items.map((i) => i.label)).toEqual(['Back', 'Forward', 'Reload'])
    expect(popups[1].options).toEqual({ window: 'host window' })
  })
})
