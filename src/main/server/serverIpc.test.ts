import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>

const handlers = vi.hoisted(() => new Map<string, Handler>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}))

import { registerServerIpc } from './serverIpc'

const webview = { sender: { getType: () => 'webview' } }

const account = {
  status: vi.fn(),
  setUrl: vi.fn(),
  info: vi.fn(),
  signInWithInvite: vi.fn(),
  githubStart: vi.fn(),
  githubPoll: vi.fn(),
  githubCancel: vi.fn(),
  verificationUri: vi.fn(),
  signOut: vi.fn(),
}
const openExternal = vi.fn(() => true)

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerServerIpc({ account: account as never, allowInsecure: false, openExternal })
})

describe('server owner IPC', () => {
  it('SSY-C120 answers no channel for a sender that is not a top-level window', async () => {
    expect([...handlers.keys()].sort()).toEqual([
      'server:github-cancel',
      'server:github-poll',
      'server:github-start',
      'server:info',
      'server:open-verification',
      'server:set-url',
      'server:sign-in-invite',
      'server:sign-out',
      'server:status',
    ])
    for (const handler of handlers.values()) await handler(webview, 'code')
    for (const fn of Object.values(account)) expect(fn).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
