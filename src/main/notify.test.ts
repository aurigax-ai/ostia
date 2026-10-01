import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'pine-notify-'))
const ipcHandlers = new Map<string, (...args: unknown[]) => void>()
const shown: { title: string; silent?: boolean }[] = []

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => true
    constructor(private readonly options: { title: string; silent?: boolean }) {}
    on() {}
    show() {
      shown.push(this.options)
    }
  }
  return {
    Notification,
    app: { getPath: () => userData },
    ipcMain: {
      handle: vi.fn(),
      on: (channel: string, fn: (...args: unknown[]) => void) => ipcHandlers.set(channel, fn),
    },
  }
})
vi.mock('./jsonStore', () => ({ loadJson: () => [], saveJson: vi.fn(), storePath: () => 'log' }))
vi.mock('./events', () => ({ emitPlatformEvent: vi.fn() }))

const { registerNotifyIpc } = await import('./notify')

let windows: {
  isDestroyed: () => boolean
  isVisible: () => boolean
  isFocused: () => boolean
  webContents: { send: () => void }
}[] = []

function pineWindow(state: { visible: boolean; focused: boolean }) {
  return {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    webContents: { send: () => {} },
  }
}

registerNotifyIpc({
  windows: () => windows,
  windowById: () => undefined,
  execCommand: vi.fn(),
} as unknown as Parameters<typeof registerNotifyIpc>[0])

function post(desktop: boolean): void {
  ipcHandlers.get('notifications:post')?.(
    { sender: { id: 1 } },
    { paneId: 'p1', title: 'Agent finished', desktop },
  )
}

function settings(notifications: object): void {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ notifications }))
}

afterEach(() => {
  shown.length = 0
  windows = []
})

describe('desktop notifications', () => {
  it('sends nothing to the system while a Pine window is focused', () => {
    settings({})
    windows = [pineWindow({ visible: true, focused: true })]
    post(true)
    expect(shown).toEqual([])
  })

  it('still notifies the system when Pine is in the background or hidden in the tray', () => {
    settings({})
    windows = [pineWindow({ visible: true, focused: false })]
    post(true)
    windows = [pineWindow({ visible: false, focused: true })]
    post(true)
    expect(shown).toHaveLength(2)
  })

  it('notifies the system while focused when the human asked for it', () => {
    settings({ whenFocused: true })
    windows = [pineWindow({ visible: true, focused: true })]
    post(true)
    expect(shown).toHaveLength(1)
  })

  it('shows a banner with sound by default', () => {
    settings({})
    post(true)
    expect(shown).toEqual([{ title: 'Agent finished', body: undefined, silent: false }])
  })

  it('is silent when sound is off', () => {
    settings({ sound: false })
    post(true)
    expect(shown[0]?.silent).toBe(true)
  })

  it('shows nothing when desktop notifications are off, or when the renderer declined', () => {
    settings({ desktop: false })
    post(true)
    settings({})
    post(false)
    expect(shown).toEqual([])
  })
})
