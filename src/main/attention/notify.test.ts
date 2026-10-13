import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { CommandResult } from '../../shared/types'

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
vi.mock('../approvals/approvals', () => ({ approvals: () => null }))

const listHandlers = new Map<string, () => unknown>()
const electron = await import('electron')
vi.mocked(electron.ipcMain.handle).mockImplementation((channel, fn) => {
  listHandlers.set(channel, fn as () => unknown)
})

const { registerNotifyIpc, registerNotifyMethods, notificationsRecorded } = await import('./notify')
const { setScriptTokenCheck } = await import('../control/controlAuth')
const { registerControlServer, stopControlServer } = await import('../control/controlServer')

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

const notifyDeps = {
  windows: () => windows,
  windowById: () => undefined,
  execCommand: vi.fn(),
  isScratchPane: (paneId: string) => paneId === 'scratch-pane',
  redact: async (text: string) => text.replaceAll(SECRET, '[redacted:test]'),
} as unknown as Parameters<typeof registerNotifyIpc>[0]
registerNotifyIpc(notifyDeps)
registerNotifyMethods(notifyDeps)
setScriptTokenCheck((token) => {
  if (token === 'ostia_notify') return { id: 'script_notify', caps: ['notify'] }
  return token === 'ostia_quiet' ? { id: 'script_quiet', caps: ['read-board'] } : undefined
})

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

  it('a recorded notification runs the configured command with its placeholders filled', async () => {
    const script = join(userData, 'on-notify.sh')
    const out = join(userData, 'notified.txt')
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$2" "$3" > "${out}.part" && mv "${out}.part" "${out}"\n`,
    )
    chmodSync(script, 0o755)
    settings({ desktop: false, command: `${script} {title} "{body}" {pane}` })

    post(false, 'pane-x', 'all; green')
    await notificationsRecorded()
    await vi.waitFor(
      () => expect(readFileSync(out, 'utf8')).toBe('Agent finished|all; green|pane-x'),
      { timeout: 3000 },
    )
  })
})

describe('notify from a script token', () => {
  const socketPath = join(tmpdir(), `ostia-notify-${process.pid}.sock`)

  async function script(token: string): Promise<MessageConnection> {
    registerControlServer(
      {
        execCommand: async () => ({ ok: true }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
    const socket = createConnection(socketPath)
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    conn.listen()
    await conn.sendRequest('hello', { token })
    return conn
  }

  afterEach(() => stopControlServer())

  it('shows a desktop notification and logs it under the token, without a pane', async () => {
    settings({})
    const conn = await script('ostia_notify')
    await expect(
      conn.sendRequest('notify', { title: 'Line done', body: 'tracker#24' }),
    ).resolves.toEqual({
      ok: true,
    })
    await notificationsRecorded()
    conn.dispose()
    expect(shown).toEqual([{ title: 'Line done', body: 'tracker#24', silent: false }])
    expect(saved[0]).toEqual([
      expect.objectContaining({ title: 'Line done', from: 'script_notify', paneId: undefined }),
    ])
    expect(notifyDeps.execCommand).not.toHaveBeenCalled()
  })

  it('needs notify on the token', async () => {
    const conn = await script('ostia_quiet')
    await expect(conn.sendRequest('notify', { title: 'x' })).rejects.toThrow(
      'needs-elevation: notify',
    )
    conn.dispose()
    expect(shown).toEqual([])
  })
})
