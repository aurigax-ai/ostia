import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildSnapshot, restoreSnapshot } from '@/lib/layout/snapshot'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

vi.mock('@/lib/terminal/blockActions', () => ({ runWhenIdle: vi.fn(() => vi.fn()) }))

const { runWhenIdle } = await import('@/lib/terminal/blockActions')
const { RESUME_FAIL_WINDOW_MS, resumeStarted } = await import('./resumeOutcome')
const { dismissResumeFailure, retryResume, startNewSession } = await import('./resumeFailure')
const { resumeWhenIdle } = await import('./resumeFolder')
const { resumeAnyway } = await import('./folderTrust')
const { startAutoResume } = await import('./autoResume')
const { startAgentRunningReport } = await import('./agentRunningReport')

const resume = { agent: 'claude' as const, id: 'dead1234-0000-4000-8000-000000000000' }

const pane: PaneNode = {
  type: 'pane',
  id: 'p1',
  title: 'claude',
  kind: 'terminal',
  resume,
  resumePending: true,
}

const current = () => findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')
const typed = () => vi.mocked(runWhenIdle).mock.calls.map(([, command]) => command)

function typeResume(): void {
  resumeWhenIdle('p1', resume)
  const onTyped = vi.mocked(runWhenIdle).mock.calls.at(-1)?.[5]
  onTyped?.()
}

function runBlock(exitCode: number, beforeEnd?: () => void): void {
  const blocks = useBlocksStore.getState()
  blocks.promptStart('p1', { line: 0 }, '/w')
  blocks.commandStart('p1', { line: 1 }, `'claude' --resume ${resume.id}`)
  beforeEnd?.()
  useBlocksStore.getState().commandEnd('p1', { line: 2 }, exitCode)
}

function saved(): PaneNode | null {
  const layout = useLayoutStore.getState().byWorkspace.w1
  const snapshot = buildSnapshot({
    workspaces: [{ id: 'w1', name: 'w', kind: 'terminal', workDir: '/w' }],
    groups: [],
    activeWorkspaceId: 'w1',
    layouts: { w1: layout },
    savedAt: '',
    liveAgentPanes: new Set(['p1']),
  })
  const root = restoreSnapshot(snapshot).layouts.w1?.root
  return root ? findPane(root, 'p1') : null
}

describe('a typed resume that fails', () => {
  const init = {
    layout: useLayoutStore.getState(),
    blocks: useBlocksStore.getState(),
    settings: useSettingsStore.getState(),
  }
  const stops: (() => void)[] = []

  beforeAll(() => vi.mocked(runWhenIdle).mockClear())

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    vi.mocked(runWhenIdle).mockClear()
    vi.mocked(window.ostia.pty.reportAgentRunning).mockClear()
    vi.mocked(window.ostia.pty.reportWaking).mockClear()
    useLayoutStore.setState(init.layout, true)
    useBlocksStore.setState(init.blocks, true)
    useSettingsStore.setState(init.settings, true)
  })

  function seed(): void {
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: 'p1', zoomedPaneId: null } },
    })
  }

  it('tells main the wake ended with the exit code when the typed resume fails', () => {
    seed()
    typeResume()
    runBlock(1)
    expect(window.ostia.pty.reportWaking).toHaveBeenCalledWith(
      'p1',
      false,
      'its agent exited with code 1 before it started',
    )
  })

  it('RSM-C2 moves the token into the saved failure, so it is never typed again but survives a restart', () => {
    seed()
    typeResume()
    runBlock(1)

    expect(current()?.resume).toBeUndefined()
    expect(current()?.resumePending).toBeUndefined()
    expect(current()?.resumeFailed).toEqual({ resume, exitCode: 1 })

    const back = saved()
    expect(back?.resume).toBeUndefined()
    expect(back?.resumeFailed).toEqual({ resume, exitCode: 1 })
    expect(back?.resumePending).toBeUndefined()

    vi.mocked(runWhenIdle).mockClear()
    useSettingsStore.setState((s) => ({ agents: { ...s.agents, autoResume: true } }))
    stops.push(startAutoResume())
    expect(typed()).toEqual([])
  })

  it('RSM-C3 tells main the pane no longer runs an agent', () => {
    seed()
    stops.push(startAgentRunningReport())
    typeResume()
    useBlocksStore.getState().resetPane('p1')
    runBlock(1)
    expect(vi.mocked(window.ostia.pty.reportAgentRunning).mock.calls.at(-1)).toEqual(['p1', false])
  })

  it('RSM-C4 keeps the token when the agent reported its start before it exited', () => {
    seed()
    typeResume()
    runBlock(1, () => resumeStarted('p1'))
    expect(current()?.resume).toEqual(resume)
    expect(current()?.resumeFailed).toBeUndefined()
  })

  it('RSM-C5 keeps the token when the agent exits cleanly', () => {
    seed()
    typeResume()
    runBlock(0)
    expect(current()?.resume).toEqual(resume)
    expect(current()?.resumeFailed).toBeUndefined()
  })

  it('RSM-C6 ignores a block that was not the typed resume', () => {
    seed()
    runBlock(1)
    expect(current()?.resume).toEqual(resume)
  })

  it('RSM-C13 never watches when that agent’s hooks are off, since no start can be reported', () => {
    seed()
    useSettingsStore.setState((s) => ({
      agents: { ...s.agents, hooks: { ...s.agents.hooks, claude: false } },
    }))
    typeResume()
    runBlock(1)
    expect(current()?.resume).toEqual(resume)
    expect(current()?.resumeFailed).toBeUndefined()
  })

  it('RSM-C14 keeps the token when the agent ends on a signal, such as Ctrl+C', () => {
    for (const exitCode of [130, 143, 137]) {
      seed()
      typeResume()
      runBlock(exitCode)
      expect(current()?.resume).toEqual(resume)
      expect(current()?.resumeFailed).toBeUndefined()
    }
  })

  it('RSM-C15 keeps the token when the agent fails only after the short window', () => {
    vi.useFakeTimers()
    try {
      seed()
      typeResume()
      const blocks = useBlocksStore.getState()
      blocks.promptStart('p1', { line: 0 }, '/w')
      blocks.commandStart('p1', { line: 1 }, `'claude' --resume ${resume.id}`)
      vi.advanceTimersByTime(RESUME_FAIL_WINDOW_MS + 1)
      useBlocksStore.getState().commandEnd('p1', { line: 2 }, 1)
      expect(current()?.resume).toEqual(resume)
      expect(current()?.resumeFailed).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('RSM-C16 still fails a resume that ends within the window, the way a missing session does', () => {
    vi.useFakeTimers()
    try {
      seed()
      typeResume()
      const blocks = useBlocksStore.getState()
      blocks.promptStart('p1', { line: 0 }, '/w')
      blocks.commandStart('p1', { line: 1 }, `'claude' --resume ${resume.id}`)
      vi.advanceTimersByTime(RESUME_FAIL_WINDOW_MS - 1_000)
      useBlocksStore.getState().commandEnd('p1', { line: 2 }, 1)
      expect(current()?.resumeFailed).toEqual({ resume, exitCode: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('RSM-C7 tries again with the same token, only on the human’s click', () => {
    seed()
    typeResume()
    runBlock(1)
    vi.mocked(runWhenIdle).mockClear()
    retryResume('p1')
    expect(current()?.resume).toEqual(resume)
    expect(current()?.resumeFailed).toBeUndefined()
    expect(typed()).toEqual([`'claude' --resume ${resume.id}`])
  })

  it('RSM-C8 starts a new session of the same agent and clears the note', () => {
    seed()
    typeResume()
    runBlock(1)
    vi.mocked(runWhenIdle).mockClear()
    startNewSession('p1')
    expect(current()?.resumeFailed).toBeUndefined()
    expect(current()?.resume).toBeUndefined()
    expect(typed()).toEqual(["'claude'"])
  })

  it('CFT-C19 Try again and Start new session ask about an untrusted folder before typing', async () => {
    vi.mocked(window.ostia.agentSession.folderTrust).mockResolvedValue({
      state: 'ask',
      folder: '/w',
    })
    for (const act of [retryResume, startNewSession]) {
      seed()
      typeResume()
      runBlock(1)
      vi.mocked(runWhenIdle).mockClear()
      act('p1')
      const allowed = vi.mocked(runWhenIdle).mock.calls[0]?.[3]
      void allowed?.()
      await vi.waitFor(() => expect(useFolderTrustStore.getState().byPane).toEqual({ p1: '/w' }))
      resumeAnyway('p1')
    }
  })

  it('RSM-C9 dismisses the note without typing anything', () => {
    seed()
    typeResume()
    runBlock(1)
    vi.mocked(runWhenIdle).mockClear()
    dismissResumeFailure('p1')
    expect(current()?.resumeFailed).toBeUndefined()
    expect(typed()).toEqual([])
  })
})
