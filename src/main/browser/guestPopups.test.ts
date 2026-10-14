import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  POPUP_GESTURE_MS,
  humanGestureAllowsPopup,
  noteAgentDrive,
  openHumanPopups,
  popupTitle,
} from './guestPopups'

type OpenHandler = () => { action: 'allow' | 'deny'; overrideBrowserWindowOptions?: unknown }

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
  openHumanPopups(guest, {
    isHumanProfile: () => opts.human ?? true,
    ownerWindow: () => (opts.owned === false ? null : parent),
    prepare,
    now: () => at,
  })
  return {
    guest,
    parent,
    prepare,
    input: (type: string) => guest.emit('input-event', {}, { type }),
    agent: () => noteAgentDrive(guest.id, at),
    pass: (ms: number) => {
      at += ms
    },
    open: () => {
      if (!handler) throw new Error('no window open handler')
      return (handler as OpenHandler)()
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
    expect((nested as unknown as OpenHandler)()).toEqual({ action: 'deny' })
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
