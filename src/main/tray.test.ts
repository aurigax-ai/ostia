import { describe, expect, it, vi } from 'vitest'

const trays: {
  destroyed: boolean
  tooltip: string
  menu: { label?: string; click?: () => void }[]
}[] = []

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  Tray: class {
    destroyed = false
    tooltip = ''
    menu: unknown[] = []
    constructor() {
      trays.push(this as never)
    }
    setToolTip(text: string): void {
      this.tooltip = text
    }
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

const {
  AppTray,
  closeAction,
  isHiddenLaunch,
  readCloseToTray,
  trayLabels,
  trayTooltip,
  unreadWorkspaces,
} = await import('./tray')

function fakeWindow(events: string[]) {
  let visible = true
  const onShow: (() => void)[] = []
  return {
    isDestroyed: () => false,
    isVisible: () => visible,
    hide: () => {
      visible = false
      events.push('hide')
    },
    show: () => {
      visible = true
      events.push('show')
      for (const listener of onShow.splice(0)) listener()
    },
    focus: () => events.push('focus'),
    once: (event: string, listener: () => void) => {
      if (event === 'show') onShow.push(listener)
    },
  } as unknown as Electron.BrowserWindow
}

function makeTray(
  events: string[],
  win: Electron.BrowserWindow,
  setBadgeCount: (count: number) => void = () => undefined,
) {
  return new AppTray({
    iconPath: '/icon.png',
    tooltip: 'Pine',
    locale: () => 'en',
    windows: () => [win],
    quit: () => events.push('quit'),
    setBadgeCount,
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

  it('removes the tray icon when the hidden window is shown some other way', () => {
    const events: string[] = []
    const win = fakeWindow(events)
    const tray = makeTray(events, win)
    tray.hide(win)
    win.show()
    expect(tray.visible).toBe(false)
    expect(trays.at(-1)?.destroyed).toBe(true)
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

describe('unread count', () => {
  const ws = (state: string, unreadAt: number) =>
    ({ id: 'w', name: 'w', workDir: '/', state, unreadAt, panes: [] }) as never

  it('counts workspaces with an unread notification or a waiting agent in every window', () => {
    expect(
      unreadWorkspaces([
        { windowId: '1', detached: false, workspaces: [ws('idle', 5), ws('waiting', 0)] },
        { windowId: '2', detached: true, workspaces: [ws('working', 0), ws('done', 9)] },
      ]),
    ).toBe(3)
    expect(unreadWorkspaces([])).toBe(0)
  })

  it('puts the count in the tray tooltip and the badge, and drops it at zero', () => {
    expect(trayTooltip('Pine', 0, 'en')).toBe('Pine')
    expect(trayTooltip('Pine', 2, 'en')).toBe('Pine · 2 unread')
    expect(trayTooltip('Pine', 2, 'zh-Hant')).toBe('Pine · 2 則未讀')
    const events: string[] = []
    const win = fakeWindow(events)
    const badge = vi.fn()
    const tray = makeTray(events, win, badge)
    tray.setUnread(3)
    tray.hide(win)
    expect(trays.at(-1)?.tooltip).toBe('Pine · 3 unread')
    tray.setUnread(0)
    expect(trays.at(-1)?.tooltip).toBe('Pine')
    expect(badge.mock.calls).toEqual([[3], [0]])
  })
})

describe('closeAction', () => {
  it('MGR-C1 hides the window when close-to-tray is on', () => {
    expect(
      closeAction({
        quitApproved: false,
        closeToTray: true,
        startedHidden: false,
        managerLive: false,
      }),
    ).toBe('hide')
  })

  it('MGR-C2 closes the window when close-to-tray is off', () => {
    expect(
      closeAction({
        quitApproved: false,
        closeToTray: false,
        startedHidden: false,
        managerLive: false,
      }),
    ).toBe('close')
  })

  it('MGR-C1 hides the window when Pine was started hidden, even with the setting off', () => {
    expect(
      closeAction({
        quitApproved: false,
        closeToTray: false,
        startedHidden: true,
        managerLive: false,
      }),
    ).toBe('hide')
  })

  it('MGR-C6 closes instead of hiding once a quit was approved', () => {
    expect(
      closeAction({
        quitApproved: true,
        closeToTray: true,
        startedHidden: true,
        managerLive: true,
      }),
    ).toBe('close')
  })

  it('MGR-C19 hides the window while a manager is live, even with close-to-tray off', () => {
    expect(
      closeAction({
        quitApproved: false,
        closeToTray: false,
        startedHidden: false,
        managerLive: true,
      }),
    ).toBe('hide')
  })
})

describe('readCloseToTray', () => {
  it('MGR-C1 reads workspaces.closeToTray when it is true', () => {
    expect(readCloseToTray({ workspaces: { closeToTray: true } })).toBe(true)
  })

  it('MGR-C5 treats missing or malformed settings as on, the default', () => {
    expect(readCloseToTray(undefined)).toBe(true)
    expect(readCloseToTray({})).toBe(true)
    expect(readCloseToTray({ workspaces: null })).toBe(true)
    expect(readCloseToTray({ workspaces: { closeToTray: 'yes' } })).toBe(true)
    expect(readCloseToTray({ workspaces: { closeToTray: 1 } })).toBe(true)
  })

  it('MGR-C2 reads workspaces.closeToTray when the human turned it off', () => {
    expect(readCloseToTray({ workspaces: { closeToTray: false } })).toBe(false)
  })
})

describe('isHiddenLaunch', () => {
  it('MGR-C41 MGR-C42 reveals the running Pine on a plain second launch but not on a hidden one', () => {
    expect(isHiddenLaunch(['/opt/pine/pine'])).toBe(false)
    expect(isHiddenLaunch(['/opt/pine/pine', '--hidden'])).toBe(true)
  })
})

describe('trayLabels', () => {
  it('uses Traditional Chinese labels for zh-Hant and English otherwise', () => {
    expect(trayLabels('zh-Hant').quit).toBe('結束')
    expect(trayLabels('fr').show).toBe('Show')
    expect(trayLabels(undefined).show).toBe('Show')
  })
})
