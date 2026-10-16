import { EventEmitter } from 'node:events'
import type { BrowserWindow, HandlerDetails, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./guestLinkClicks', () => ({
  clickedLinkOf: (message: string) => (message.startsWith('clicked ') ? message.slice(8) : null),
}))

const {
  LINK_CLICK_MS,
  POPUP_GESTURE_MS,
  humanGestureAllowsPopup,
  noteAgentDrive,
  openHumanPopups,
  popupTitle,
} = await import('./guestPopups')

type OpenHandler = (details: HandlerDetails) => {
  action: 'allow' | 'deny'
  overrideBrowserWindowOptions?: unknown
}

const POPUP: HandlerDetails = {
  url: 'https://accounts.example.com/authorize',
  frameName: 'signin',
  features: 'popup,width=420,height=520',
  disposition: 'new-window',
  referrer: { url: 'https://site.example/', policy: 'strict-origin-when-cross-origin' },
}

const link = (disposition: HandlerDetails['disposition'], url = 'https://docs.example.com/') => ({
  ...POPUP,
  url,
  frameName: '',
  features: '',
  disposition,
})

let nextGuestId = 100

function setup(opts: { human?: boolean; owned?: boolean } = {}) {
  let handler: OpenHandler | null = null
  let at = 1_000_000
  const parent = { id: 'owner' } as unknown as BrowserWindow
  const guest = Object.assign(new EventEmitter(), {
    id: nextGuestId++,
    setWindowOpenHandler: (fn: OpenHandler) => {
      handler = fn
    },
  }) as unknown as WebContents & EventEmitter
  const prepare = vi.fn()
  const openTab = vi.fn()
  openHumanPopups(guest, {
    isHumanProfile: () => opts.human ?? true,
    ownerWindow: () => (opts.owned === false ? null : parent),
    prepare,
    openTab,
    now: () => at,
  })
  return {
    guest,
    parent,
    prepare,
    openTab,
    input: (type: string) => guest.emit('input-event', {}, { type }),
    click: (href = 'https://docs.example.com/') => {
      guest.emit('input-event', {}, { type: 'mouseDown' })
      guest.emit('console-message', { message: `clicked ${href}` })
    },
    agent: () => noteAgentDrive(guest.id, at),
    pass: (ms: number) => {
      at += ms
    },
    open: (details: HandlerDetails = POPUP) => {
      if (!handler) throw new Error('no window open handler')
      return (handler as OpenHandler)(details)
    },
  }
}

describe('humanGestureAllowsPopup', () => {
  it('needs an input no older than the gesture window', () => {
    expect(humanGestureAllowsPopup(undefined, 10)).toBe(false)
    expect(humanGestureAllowsPopup({}, 10)).toBe(false)
    expect(humanGestureAllowsPopup({ inputAt: 0 }, POPUP_GESTURE_MS)).toBe(true)
    expect(humanGestureAllowsPopup({ inputAt: 0 }, POPUP_GESTURE_MS + 1)).toBe(false)
  })

  it('refuses while an agent drove the guest inside the window', () => {
    expect(humanGestureAllowsPopup({ inputAt: 100, agentAt: 90 }, 200)).toBe(false)
    expect(humanGestureAllowsPopup({ inputAt: 100, agentAt: 150 }, 200)).toBe(false)
    const later = POPUP_GESTURE_MS + 200
    expect(humanGestureAllowsPopup({ inputAt: later - 10, agentAt: 100 }, later)).toBe(true)
  })
})

describe('openHumanPopups', () => {
  it('opens a child window of the owner, without a preload, right after the human’s click', () => {
    const { input, open, parent } = setup()
    input('mouseDown')
    expect(open()).toEqual({
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent,
        autoHideMenuBar: true,
        webPreferences: {
          preload: undefined,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
        },
      },
    })
  })

  it('opens one window per gesture', () => {
    const { input, open } = setup()
    input('keyDown')
    expect(open().action).toBe('allow')
    expect(open().action).toBe('deny')
  })

  it('opens nothing without an input, for a pointer move or after the window passed', () => {
    const { input, open, pass } = setup()
    expect(open().action).toBe('deny')
    input('mouseMove')
    expect(open().action).toBe('deny')
    input('mouseDown')
    pass(POPUP_GESTURE_MS + 1)
    expect(open().action).toBe('deny')
  })

  it('opens nothing for a pane outside the human’s profile or without an app window', () => {
    const agentPane = setup({ human: false })
    agentPane.input('mouseDown')
    expect(agentPane.open().action).toBe('deny')
    const orphan = setup({ owned: false })
    orphan.input('mouseDown')
    expect(orphan.open().action).toBe('deny')
  })

  it('opens nothing for input an agent sent into the human’s pane', () => {
    const { input, open, agent, pass } = setup()
    agent()
    input('mouseDown')
    expect(open().action).toBe('deny')
    pass(POPUP_GESTURE_MS - 1)
    input('mouseDown')
    expect(open().action).toBe('deny')
    pass(2)
    input('mouseDown')
    expect(open().action).toBe('allow')
  })

  it('opens the link the human clicked as a shown tab and a modified click as a background tab', () => {
    const { guest, click, input, open, openTab } = setup()
    click()
    expect(open(link('foreground-tab'))).toEqual({ action: 'deny' })
    expect(openTab).toHaveBeenLastCalledWith(
      guest,
      'https://docs.example.com/',
      false,
      POPUP.referrer,
    )
    input('mouseDown')
    expect(open(link('background-tab', 'http://127.0.0.1:8080/a'))).toEqual({ action: 'deny' })
    expect(openTab).toHaveBeenLastCalledWith(guest, 'http://127.0.0.1:8080/a', true, POPUP.referrer)
    expect(open(link('foreground-tab'))).toEqual({ action: 'deny' })
    expect(openTab).toHaveBeenCalledTimes(2)
  })

  it('keeps window.open without features a popup with its opener when no link was clicked', () => {
    const { input, open, openTab, parent } = setup()
    input('mouseDown')
    expect(open(link('foreground-tab'))).toMatchObject({
      action: 'allow',
      overrideBrowserWindowOptions: { parent },
    })
    expect(openTab).not.toHaveBeenCalled()
  })

  it('keeps a popup for another address, a stale click, a named window, features, a non-web address or a form post', () => {
    const { click, open, openTab, pass } = setup()
    const cases: [string | null, HandlerDetails][] = [
      ['https://docs.example.com/other', link('foreground-tab')],
      [null, link('foreground-tab')],
      ['https://docs.example.com/', { ...link('foreground-tab'), frameName: 'docs' }],
      ['https://docs.example.com/', { ...link('foreground-tab'), features: 'noopener' }],
      ['https://docs.example.com/', POPUP],
      ['about:blank', link('foreground-tab', 'about:blank')],
      [
        'https://docs.example.com/',
        { ...link('foreground-tab'), postBody: { data: [], contentType: 'text/plain' } },
      ],
    ]
    for (const [href, details] of cases) {
      if (href === null) {
        click()
        pass(LINK_CLICK_MS + 1)
      } else {
        click(href)
      }
      expect(open(details).action).toBe('allow')
    }
    expect(openTab).not.toHaveBeenCalled()
  })

  it('uses a clicked link once', () => {
    const { click, input, open, openTab } = setup()
    click()
    expect(open(link('foreground-tab')).action).toBe('deny')
    input('mouseDown')
    expect(open(link('foreground-tab')).action).toBe('allow')
    expect(openTab).toHaveBeenCalledTimes(1)
  })

  it('opens no tab without the human’s input, from an agent pane or for an agent’s input', () => {
    const quiet = setup()
    quiet.guest.emit('console-message', { message: 'clicked https://docs.example.com/' })
    expect(quiet.open(link('foreground-tab')).action).toBe('deny')
    quiet.click()
    quiet.pass(POPUP_GESTURE_MS + 1)
    expect(quiet.open(link('background-tab')).action).toBe('deny')
    expect(quiet.openTab).not.toHaveBeenCalled()

    const agentPane = setup({ human: false })
    agentPane.click()
    expect(agentPane.open(link('foreground-tab')).action).toBe('deny')
    expect(agentPane.open(link('background-tab')).action).toBe('deny')
    expect(agentPane.openTab).not.toHaveBeenCalled()

    const driven = setup()
    driven.agent()
    driven.click()
    expect(driven.open(link('foreground-tab')).action).toBe('deny')
    expect(driven.open(link('background-tab')).action).toBe('deny')
    expect(driven.openTab).not.toHaveBeenCalled()
  })

  it('forgets a destroyed guest', () => {
    const { guest, input, open } = setup()
    input('mouseDown')
    guest.emit('destroyed')
    expect(open().action).toBe('deny')
  })

  it('shows the host in the popup title, denies nested popups and hands the window on', () => {
    const { guest, prepare } = setup()
    let nested: OpenHandler | null = null
    const popup = Object.assign(new EventEmitter(), {
      removeMenu: vi.fn(),
      setTitle: vi.fn(),
      webContents: {
        getURL: () => 'https://accounts.example.com/next',
        setWindowOpenHandler: (fn: OpenHandler) => {
          nested = fn
        },
      },
    })
    guest.emit('did-create-window', popup, { url: 'https://accounts.example.com/authorize' })
    expect(popup.removeMenu).toHaveBeenCalled()
    expect(popup.setTitle).toHaveBeenLastCalledWith('accounts.example.com')
    expect((nested as unknown as OpenHandler)(POPUP)).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    popup.emit('page-title-updated', event, 'Your bank')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(popup.setTitle).toHaveBeenLastCalledWith('accounts.example.com · Your bank')
    expect(prepare).toHaveBeenCalledWith(popup, 'https://accounts.example.com/authorize')
  })
})

describe('popupTitle', () => {
  it('leads with the host and falls back to the title alone', () => {
    expect(popupTitle('http://127.0.0.1:8080/a', 'Sign in')).toBe('127.0.0.1:8080 · Sign in')
    expect(popupTitle('https://id.example.com/', 'id.example.com')).toBe('id.example.com')
    expect(popupTitle('about:blank', 'Loading')).toBe('Loading')
    expect(popupTitle('not a url', '')).toBe('')
  })
})
