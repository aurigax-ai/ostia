import { describe, expect, it, vi } from 'vitest'

const trays: { destroyed: boolean; menu: { label?: string; click?: () => void }[] }[] = []

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  Tray: class {
    destroyed = false
    menu: unknown[] = []
    constructor() {
      trays.push(this as never)
    }
    setToolTip(): void {}
    setContextMenu(menu: unknown[]): void {
      this.menu = menu
    }
    on(): void {}
    destroy(): void {
      this.destroyed = true
    }
  },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
}))

const { AppTray, closeAction, readCloseToTray, trayLabels } = await import('./tray')

function fakeWindow(events: string[]) {
  return {
    isDestroyed: () => false,
    hide: () => events.push('hide'),
    show: () => events.push('show'),
    focus: () => events.push('focus'),
  } as unknown as Electron.BrowserWindow
}

function makeTray(events: string[], win: Electron.BrowserWindow) {
  return new AppTray({
    iconPath: '/icon.png',
    tooltip: 'Pine',
    locale: () => 'en',
    windows: () => [win],
    quit: () => events.push('quit'),
  })
}

function menuItem(label: string) {
  const item = trays.at(-1)?.menu.find((m) => m.label === label)
  if (!item?.click) throw new Error(`no tray item ${label}`)
  return item.click
}

describe('AppTray', () => {
  it('MGR-C1 hides the window and shows one tray icon', () => {
    const events: string[] = []
    const win = fakeWindow(events)
    const tray = makeTray(events, win)
    const before = trays.length
    tray.hide(win)
    tray.hide(win)
    expect(events).toEqual(['hide', 'hide'])
    expect(trays.length).toBe(before + 1)
    expect(tray.visible).toBe(true)
  })

  it('MGR-C3 Show brings the window back and removes the tray icon', () => {
    const events: string[] = []
    const win = fakeWindow(events)
    const tray = makeTray(events, win)
    tray.hide(win)
    menuItem('Show')()
    expect(events).toEqual(['hide', 'show', 'focus'])
    expect(trays.at(-1)?.destroyed).toBe(true)
    expect(tray.visible).toBe(false)
  })

  it('MGR-C4 Quit shows the window before quitting so the close guard can ask', () => {
    const events: string[] = []
    const win = fakeWindow(events)
    const tray = makeTray(events, win)
    tray.hide(win)
    menuItem('Quit')()
    expect(events).toEqual(['hide', 'show', 'focus', 'quit'])
  })
})

describe('closeAction', () => {
  it('MGR-C1 hides the window when close-to-tray is on', () => {
    expect(closeAction({ quitApproved: false, closeToTray: true, startedHidden: false })).toBe(
      'hide',
    )
  })

  it('MGR-C2 closes the window when close-to-tray is off', () => {
    expect(closeAction({ quitApproved: false, closeToTray: false, startedHidden: false })).toBe(
      'close',
    )
  })

  it('MGR-C1 hides the window when Pine was started hidden, even with the setting off', () => {
    expect(closeAction({ quitApproved: false, closeToTray: false, startedHidden: true })).toBe(
      'hide',
    )
  })

  it('MGR-C6 closes instead of hiding once a quit was approved', () => {
    expect(closeAction({ quitApproved: true, closeToTray: true, startedHidden: true })).toBe(
      'close',
    )
  })
})

describe('readCloseToTray', () => {
  it('MGR-C1 reads workspaces.closeToTray when it is true', () => {
    expect(readCloseToTray({ workspaces: { closeToTray: true } })).toBe(true)
  })

  it('MGR-C5 treats missing or malformed settings as off', () => {
    expect(readCloseToTray(undefined)).toBe(false)
    expect(readCloseToTray({})).toBe(false)
    expect(readCloseToTray({ workspaces: null })).toBe(false)
    expect(readCloseToTray({ workspaces: { closeToTray: 'yes' } })).toBe(false)
    expect(readCloseToTray({ workspaces: { closeToTray: 1 } })).toBe(false)
  })
})

describe('trayLabels', () => {
  it('uses Traditional Chinese labels for zh-Hant and English otherwise', () => {
    expect(trayLabels('zh-Hant').quit).toBe('結束')
    expect(trayLabels('fr').show).toBe('Show')
    expect(trayLabels(undefined).show).toBe('Show')
  })
})
