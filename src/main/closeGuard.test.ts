import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ipcOn = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { on: ipcOn } }))

const {
  RUNNING_ANSWER_MS,
  ask,
  confirmQuit,
  parseRunningGroups,
  registerCloseGuard,
  withScratchFiles,
} = await import('./closeGuard')

registerCloseGuard()
const answer = ipcOn.mock.calls.find(([channel]) => channel === 'window:close-answer')?.[1] as (
  e: { sender: { id: number } },
  requestId: number,
  value: unknown,
) => void

function silentWindow(id = 7): { win: BrowserWindow; sent: [string, number][] } {
  const sent: [string, number][] = []
  const contents = {
    id,
    isLoading: () => false,
    isCrashed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    send: (channel: string, requestId: number) => sent.push([channel, requestId]),
  }
  const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  return { win, sent }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ask', () => {
  it('gives up on a window that never answers once the timeout passes', async () => {
    vi.useFakeTimers()
    const { win } = silentWindow()
    let result: unknown = 'pending'
    void ask(win, 'window:running', undefined, ['gone'], 1000).then((v) => {
      result = v
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual(['gone'])
  })

  it('takes the window answer when it comes before the timeout', async () => {
    vi.useFakeTimers()
    const { win, sent } = silentWindow(9)
    const pending = ask(win, 'window:running', undefined, [], 1000)
    answer({ sender: { id: 9 } }, sent[0][1], ['answered'])
    expect(await pending).toEqual(['answered'])
    await vi.advanceTimersByTimeAsync(1000)
  })
})

describe('confirmQuit', () => {
  it('quits without asking when a window is still booting and cannot answer yet', async () => {
    vi.useFakeTimers()
    const { win, sent } = silentWindow()
    let approved: boolean | null = null
    void confirmQuit([win], win, () => 0).then((v) => {
      approved = v
    })
    await vi.advanceTimersByTimeAsync(RUNNING_ANSWER_MS)
    expect(approved).toBe(true)
    expect(sent.map(([channel]) => channel)).toEqual(['window:running'])
  })
})

describe('parseRunningGroups', () => {
  it('keeps well-formed groups from every window and clips what it shows', () => {
    const groups = parseRunningGroups([
      { workspaceId: 'w1', workspace: 'api', commands: ['sleep 100', 7], files: ['/a.ts'] },
      { workspaceId: 3, workspace: 'bad' },
      'nope',
      { workspaceId: 'w2', workspace: 'web', commands: ['x'.repeat(2000)] },
    ])
    expect(groups).toEqual([
      { workspaceId: 'w1', workspace: 'api', commands: ['sleep 100'], files: ['/a.ts'] },
      { workspaceId: 'w2', workspace: 'web', commands: ['x'.repeat(512)], files: [] },
    ])
  })

  it('keeps the agents a window names apart from its shell commands', () => {
    const groups = parseRunningGroups([
      { workspaceId: 'w1', workspace: 'api', commands: [], agents: ['claude', 3], files: [] },
      { workspaceId: 'w2', workspace: 'web', commands: ['make'], agents: 'claude', files: [] },
    ])
    expect(groups).toEqual([
      { workspaceId: 'w1', workspace: 'api', commands: [], agents: ['claude'], files: [] },
      { workspaceId: 'w2', workspace: 'web', commands: ['make'], files: [] },
    ])
  })

  it('treats anything but an array as nothing running', () => {
    expect(parseRunningGroups(undefined)).toEqual([])
    expect(parseRunningGroups({ workspaceId: 'w1' })).toEqual([])
  })
})

describe('withScratchFiles', () => {
  it('adds the scratch folder file count from main and drops groups with nothing to ask about', () => {
    const groups = parseRunningGroups([
      { workspaceId: 'w1', workspace: 'Scratch', commands: [], files: [], scratchFiles: 999 },
      { workspaceId: 'w2', workspace: 'Scratch 2', commands: [], files: [] },
      { workspaceId: 'w3', workspace: 'api', commands: ['sleep 100'], files: [] },
      { workspaceId: 'w4', workspace: 'agents', commands: [], agents: ['codex'], files: [] },
    ])
    const counts: Record<string, number> = { w1: 2, w2: 0 }
    expect(withScratchFiles(groups, (id) => counts[id] ?? 0)).toEqual([
      { workspaceId: 'w1', workspace: 'Scratch', commands: [], files: [], scratchFiles: 2 },
      { workspaceId: 'w3', workspace: 'api', commands: ['sleep 100'], files: [] },
      { workspaceId: 'w4', workspace: 'agents', commands: [], agents: ['codex'], files: [] },
    ])
  })
})
