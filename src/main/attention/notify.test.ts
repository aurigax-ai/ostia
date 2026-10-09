import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'ostia-notify-'))
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
const saved: unknown[][] = []
vi.mock('../platform/jsonStore', () => ({
  loadJson: () => [],
  saveJson: (_path: string, log: unknown[]) => saved.push(log),
  storePath: () => 'log',
}))
vi.mock('../control/events', () => ({ emitPlatformEvent: vi.fn() }))

const listHandlers = new Map<string, () => unknown>()
const electron = await import('electron')
vi.mocked(electron.ipcMain.handle).mockImplementation((channel, fn) => {
  listHandlers.set(channel, fn as () => unknown)
})

const { registerNotifyIpc, notificationsRecorded } = await import('./notify')

let windows: {
  isDestroyed: () => boolean
  isVisible: () => boolean
  isFocused: () => boolean
  webContents: { send: () => void }
}[] = []

function ostiaWindow(state: { visible: boolean; focused: boolean }) {
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
  isScratchPane: (paneId: string) => paneId === 'scratch-pane',
  redact: async (text: string) => text.replaceAll(SECRET, '[redacted:test]'),
} as unknown as Parameters<typeof registerNotifyIpc>[0])

const SECRET = 'hunter2hunter2'

function post(desktop: boolean, paneId = 'p1', body?: string): void {
  ipcHandlers.get('notifications:post')?.(
    { sender: { id: 1 } },
    { paneId, title: 'Agent finished', desktop, body },
  )
}

function settings(notifications: object): void {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ notifications }))
}

afterEach(async () => {
  await notificationsRecorded()
  shown.length = 0
  windows = []
  saved.length = 0
})

describe('desktop notifications', () => {
  it('sends nothing to the system while a Ostia window is focused', () => {
    settings({})
    windows = [ostiaWindow({ visible: true, focused: true })]
    post(true)
    expect(shown).toEqual([])
  })

  it('still notifies the system when Ostia is in the background or hidden in the tray', () => {
    settings({})
    windows = [ostiaWindow({ visible: true, focused: false })]
    post(true)
    windows = [ostiaWindow({ visible: false, focused: true })]
    post(true)
    expect(shown).toHaveLength(2)
  })

  it('notifies the system while focused when the human asked for it', () => {
    settings({ whenFocused: true })
    windows = [ostiaWindow({ visible: true, focused: true })]
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

describe('scratch panes', () => {
  it('lists a scratch pane notification live but never writes it to the log file', async () => {
    settings({})
    post(true, 'scratch-pane')
    await notificationsRecorded()
    expect(shown).toHaveLength(1)
    expect(saved).toEqual([])
    const list = listHandlers.get('notifications:list')?.() as { paneId?: string }[]
    expect(list.map((entry) => entry.paneId)).toEqual(['scratch-pane'])
    post(false, 'p1')
    await notificationsRecorded()
    expect(saved).toHaveLength(1)
    expect((saved[0] as { paneId?: string }[]).map((entry) => entry.paneId)).toEqual(['p1'])
  })
})

describe('the notification log', () => {
  it('is written with secrets redacted while the banner shows what the agent sent', async () => {
    settings({})
    post(true, 'p1', `deploy key ${SECRET}`)
    await notificationsRecorded()
    expect(shown[0]).toMatchObject({ body: `deploy key ${SECRET}` })
    expect(saved[0]).toEqual([
      expect.objectContaining({ title: 'Agent finished', body: 'deploy key [redacted:test]' }),
    ])
  })

  it('keeps the order in which notifications arrived', async () => {
    settings({})
    post(false, 'p1', 'first')
    post(false, 'p1', 'second')
    await notificationsRecorded()
    expect(saved).toHaveLength(2)
    expect((saved[1] as { body?: string }[])[0].body).toBe('second')
  })
})
