import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuitAnswer, RunningGroup } from '../../shared/types'

const ipcOn = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { on: ipcOn } }))

const {
  RUNNING_ANSWER_MS,
  ask,
  confirmQuit,
  groupsFromPtys,
  parseQuitAnswer,
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

function answeringWindow(
  id: number,
  running: unknown,
  confirm: boolean | QuitAnswer,
  questions: unknown[] = [],
): BrowserWindow {
  const reply = typeof confirm === 'boolean' ? (confirm ? 'quit' : 'cancel') : confirm
  const contents = {
    id,
    isLoading: () => false,
    isCrashed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    send: (channel: string, requestId: number, payload: unknown) => {
      if (channel === 'window:confirm-close') questions.push(payload)
      queueMicrotask(() =>
        answer({ sender: { id } }, requestId, channel === 'window:running' ? running : reply),
      )
    },
  }
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    focus: vi.fn(),
    webContents: contents,
  } as unknown as BrowserWindow
}

function crashedWindow(id: number): BrowserWindow {
  const { win } = silentWindow(id)
  ;(win.webContents as unknown as { isCrashed: () => boolean }).isCrashed = () => true
  return win
}

interface Check {
  workspaces?: Record<number, { id: string; name: string }[]>
  processes?: {
    paneId: string
    workspaceId: string
    program: string | null
    agentRunning: boolean
  }[]
  kept?: string[]
  keptShells?: string[]
  native?: QuitAnswer
}

function check(spec: Check = {}) {
  const asked: (readonly RunningGroup[])[] = []
  const askedKept: number[] = []
  return {
    asked,
    askedKept,
    check: {
      scratchFiles: () => 0,
      kept: spec.kept ?? [],
      keptShells: spec.keptShells ?? [],
      workspacesOf: (win: BrowserWindow) => spec.workspaces?.[win.webContents.id] ?? [],
      processes: () => spec.processes ?? [],
      confirmNative: async (groups: readonly RunningGroup[], keptShells: number) => {
        asked.push(groups)
        askedKept.push(keptShells)
        return spec.native ?? 'cancel'
      },
    },
  }
}

describe('confirmQuit', () => {
  it('quits without asking when a window is still booting and holds no workspace yet', async () => {
    vi.useFakeTimers()
    const { win, sent } = silentWindow()
    let approved: QuitAnswer | null = null
    void confirmQuit([win], win, check().check).then((v) => {
      approved = v
    })
    await vi.advanceTimersByTimeAsync(RUNNING_ANSWER_MS)
    expect(approved).toBe('quit')
    expect(sent.map(([channel]) => channel)).toEqual(['window:running'])
  })

  it('counts a window that misses the deadline as may be running and asks in another window', async () => {
    vi.useFakeTimers()
    const { win: slow } = silentWindow(7)
    const fast = answeringWindow(8, [], false)
    const spec = check({ workspaces: { 7: [{ id: 'w1', name: 'api' }] } })
    let approved: QuitAnswer | null = null
    void confirmQuit([slow, fast], slow, spec.check).then((v) => {
      approved = v
    })
    await vi.advanceTimersByTimeAsync(RUNNING_ANSWER_MS)
    expect(approved).toBe('cancel')
    expect(spec.asked).toEqual([])
  })

  it('asks in a native dialog when no window can show one', async () => {
    vi.useFakeTimers()
    const { win } = silentWindow(7)
    const spec = check({
      workspaces: { 7: [{ id: 'w1', name: 'api' }] },
      processes: [{ paneId: 'p1', workspaceId: 'w1', program: 'make', agentRunning: false }],
      native: 'quit',
    })
    let approved: QuitAnswer | null = null
    void confirmQuit([win], win, spec.check).then((v) => {
      approved = v
    })
    await vi.advanceTimersByTimeAsync(RUNNING_ANSWER_MS)
    expect(approved).toBe('quit')
    expect(spec.asked).toEqual([
      [{ workspaceId: 'w1', workspace: 'api', commands: ['make'], files: [], unanswered: true }],
    ])
  })

  it('reads the ptys of a crashed window instead of quitting past its agents', async () => {
    const spec = check({
      workspaces: { 7: [{ id: 'w1', name: 'api' }] },
      processes: [{ paneId: 'p1', workspaceId: 'w1', program: null, agentRunning: true }],
    })
    expect(await confirmQuit([crashedWindow(7)], undefined, spec.check)).toBe('cancel')
    expect(spec.asked).toEqual([
      [{ workspaceId: 'w1', workspace: 'api', commands: [], agents: [''], files: [] }],
    ])
  })

  it('quits at once when a crashed window has only idle shells', async () => {
    const spec = check({
      workspaces: { 7: [{ id: 'w1', name: 'api' }] },
      processes: [{ paneId: 'p1', workspaceId: 'w1', program: null, agentRunning: false }],
    })
    expect(await confirmQuit([crashedWindow(7)], undefined, spec.check)).toBe('quit')
    expect(spec.asked).toEqual([])
  })

  it('quitting with an agent idle at its prompt and auto-resume on asks nothing', async () => {
    const win = answeringWindow(9, [], false)
    const spec = check({
      workspaces: { 9: [{ id: 'w1', name: 'api' }] },
      processes: [{ paneId: 'p1', workspaceId: 'w1', program: 'claude', agentRunning: true }],
    })
    expect(await confirmQuit([win], win, spec.check)).toBe('quit')
    expect(win.focus).not.toHaveBeenCalled()
    expect(spec.asked).toEqual([])
  })

  it('asks in the window that answered with what it runs', async () => {
    const win = answeringWindow(
      9,
      [{ workspaceId: 'w1', workspace: 'api', commands: ['sleep 100'], files: [] }],
      true,
    )
    const spec = check()
    expect(await confirmQuit([win], win, spec.check)).toBe('quit')
    expect(win.focus).toHaveBeenCalled()
    expect(spec.asked).toEqual([])
  })

  it('quits without asking when every window answers that nothing runs', async () => {
    const win = answeringWindow(9, [], false)
    const spec = check()
    expect(await confirmQuit([win], win, spec.check)).toBe('quit')
    expect(win.focus).not.toHaveBeenCalled()
    expect(spec.asked).toEqual([])
  })
})

describe('confirmQuit with kept shells', () => {
  it('KSH-C97 asks about the kept shells even when nothing else would be lost', async () => {
    const questions: unknown[] = []
    const win = answeringWindow(9, [], 'keep-shells', questions)
    const spec = check({ kept: ['p1'], keptShells: ['p1'] })
    expect(await confirmQuit([win], win, spec.check)).toBe('keep-shells')
    expect(questions).toEqual([{ groups: [], keptShells: ['p1'] }])
  })

  it('KSH-C98 ends the kept shells when the window answers Quit', async () => {
    const win = answeringWindow(9, [], 'quit')
    const spec = check({ kept: ['p1'], keptShells: ['p1'] })
    expect(await confirmQuit([win], win, spec.check)).toBe('quit')
  })

  it('KSH-C99 offers the kept shells in the native dialog when no window can show one', async () => {
    const spec = check({
      workspaces: { 7: [{ id: 'w1', name: 'api' }] },
      processes: [{ paneId: 'p1', workspaceId: 'w1', program: 'claude', agentRunning: true }],
      kept: ['p1'],
      keptShells: ['p1'],
      native: 'keep-shells',
    })
    expect(await confirmQuit([crashedWindow(7)], undefined, spec.check)).toBe('keep-shells')
    expect(spec.asked).toEqual([[]])
    expect(spec.askedKept).toEqual([1])
  })
})

describe('parseQuitAnswer', () => {
  it('takes keep-shells only when keeping was offered and reads anything else as cancel', () => {
    expect(parseQuitAnswer('keep-shells', true)).toBe('keep-shells')
    expect(parseQuitAnswer('keep-shells', false)).toBe('cancel')
    expect(parseQuitAnswer('quit', true)).toBe('quit')
    expect(parseQuitAnswer(true, false)).toBe('cancel')
    expect(parseQuitAnswer(undefined, true)).toBe('cancel')
  })
})

describe('groupsFromPtys', () => {
  it('lists foreground programs and running agents per workspace and skips kept panes', () => {
    const groups = groupsFromPtys(
      [
        { id: 'w1', name: 'api' },
        { id: 'w2', name: 'web' },
      ],
      [
        { paneId: 'p1', workspaceId: 'w1', program: 'make', agentRunning: false },
        { paneId: 'p2', workspaceId: 'w1', program: 'claude', agentRunning: true },
        { paneId: 'p3', workspaceId: 'w1', program: null, agentRunning: false },
        { paneId: 'p4', workspaceId: 'w2', program: 'sleep', agentRunning: false },
      ],
      new Set(['p4']),
      false,
    )
    expect(groups).toEqual([
      { workspaceId: 'w1', workspace: 'api', commands: ['make'], agents: ['claude'], files: [] },
      { workspaceId: 'w2', workspace: 'web', commands: [], files: [] },
    ])
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

  it('keeps a window that did not answer even with nothing it knows of', () => {
    const silent = {
      workspaceId: 'w1',
      workspace: 'api',
      commands: [],
      files: [],
      unanswered: true,
    }
    expect(withScratchFiles([silent], () => 0)).toEqual([silent])
  })
})
