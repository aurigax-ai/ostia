import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useRemoteCwdStore } from '@/stores/terminal/remoteCwdStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutNode } from '../layout/types'
import { wireTerminalStateBridge } from './terminalStateBridge'

const blocks = () => useBlocksStore.getState()

function seedPaneCwd(workspaceId: string, paneId: string, cwd: string): void {
  const root: LayoutNode = { type: 'pane', id: paneId, title: 'zsh', kind: 'terminal', cwd }
  useLayoutStore.setState({
    byWorkspace: { [workspaceId]: { root, activePaneId: paneId, zoomedPaneId: null } },
  })
}

describe('wireTerminalStateBridge', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(window.ostia.terminalState.push).mockClear()
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useLayoutStore.setState(layoutInit, true)
    useRemoteCwdStore.setState({ byPane: {} })
    vi.useRealTimers()
  })

  it('GUARD: does not subscribe when window.ostia.terminalState is undefined', () => {
    const blocksSubscribe = vi.spyOn(useBlocksStore, 'subscribe')
    const layoutSubscribe = vi.spyOn(useLayoutStore, 'subscribe')
    try {
      Reflect.set(window.ostia, 'terminalState', undefined)

      expect(() => wireTerminalStateBridge()).not.toThrow()

      expect(blocksSubscribe).not.toHaveBeenCalled()
      expect(layoutSubscribe).not.toHaveBeenCalled()
    } finally {
      blocksSubscribe.mockRestore()
      layoutSubscribe.mockRestore()
    }
  })

  it('SSH-C61 sends the remote folder a pane reported, and drops it after a local report', () => {
    const push = vi.mocked(window.ostia.terminalState.push)
    wireTerminalStateBridge()
    seedPaneCwd('s1', 'pane-r', '/home/me')
    vi.advanceTimersByTime(100)
    push.mockClear()

    useRemoteCwdStore.getState().report('pane-r', { host: 'db1', cwd: '/srv/app' })
    vi.advanceTimersByTime(100)
    expect(push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneId: 'pane-r',
        cwd: '/home/me',
        remote: { host: 'db1', cwd: '/srv/app' },
      }),
    )

    useRemoteCwdStore.getState().report('pane-r', null)
    vi.advanceTimersByTime(100)
    expect(push.mock.lastCall?.[0]).not.toHaveProperty('remote')
    expect(useRemoteCwdStore.getState().byPane).toEqual({})
  })

  it('pushes a debounced snapshot 100ms after a blocksStore mutation, matching store state', () => {
    const push = vi.mocked(window.ostia.terminalState.push)
    wireTerminalStateBridge()

    blocks().resetPane('pane-b')
    blocks().commandStart('pane-b', { line: 5 })

    vi.advanceTimersByTime(99)
    expect(push).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-b',
      generation: 1,
      cwd: undefined,
      running: true,
      blockCount: 1,
      lastExitCode: undefined,
    })
  })

  it('DEBOUNCE: collapses rapid mutations into a single push of the final state', () => {
    const push = vi.mocked(window.ostia.terminalState.push)
    wireTerminalStateBridge()

    blocks().commandStart('pane-c', { line: 1 })
    vi.advanceTimersByTime(50)
    expect(push).not.toHaveBeenCalled()

    blocks().commandEnd('pane-c', { line: 2 }, 0)
    vi.advanceTimersByTime(50)
    expect(push).not.toHaveBeenCalled()

    blocks().commandStart('pane-c', { line: 3 })
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-c',
      generation: 0,
      cwd: undefined,
      running: true,
      blockCount: 2,
      lastExitCode: 0,
    })
  })

  it("reflects the pane's layoutStore cwd, and a cwd-only change schedules a push", () => {
    const push = vi.mocked(window.ostia.terminalState.push)
    wireTerminalStateBridge()

    seedPaneCwd('sess-d', 'pane-d', '/work/d')
    blocks().commandStart('pane-d', { line: 1 })
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-d',
      generation: 0,
      cwd: '/work/d',
      running: true,
      blockCount: 1,
      lastExitCode: undefined,
    })

    push.mockClear()
    useLayoutStore.getState().setCwd('sess-d', 'pane-d', '/new/d')
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-d',
      generation: 0,
      cwd: '/new/d',
      running: true,
      blockCount: 1,
      lastExitCode: undefined,
    })
  })

  it('lastExitCode is the last COMPLETED block, skipping an in-flight block; running tracks running[]', () => {
    const push = vi.mocked(window.ostia.terminalState.push)
    wireTerminalStateBridge()

    blocks().commandStart('pane-e', { line: 1 })
    blocks().commandEnd('pane-e', { line: 2 }, 5)
    blocks().commandStart('pane-e', { line: 3 })
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-e',
      generation: 0,
      cwd: undefined,
      running: true,
      blockCount: 2,
      lastExitCode: 5,
    })
  })

  it('reports running:false once the only block has completed (running[] cleared)', () => {
    const push = vi.mocked(window.ostia.terminalState.push)
    wireTerminalStateBridge()

    blocks().commandStart('pane-f', { line: 1 })
    blocks().commandEnd('pane-f', { line: 2 }, 0)
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-f',
      generation: 0,
      cwd: undefined,
      running: false,
      blockCount: 1,
      lastExitCode: 0,
    })
  })
})
