import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { wireTerminalStateBridge } from './terminalStateBridge'

/**
 * `wireTerminalStateBridge` is a passive observer that pushes a compact per-pane
 * snapshot to main, debounced (DEBOUNCE_MS = 100) on blocksStore / layoutStore changes.
 *
 * ISOLATION NOTES (the module keeps process-level state that we cannot reset):
 *  - `wireTerminalStateBridge()` adds store subscriptions that are NEVER unsubscribed,
 *    and the module keeps module-level `timers`/`prevCwd` maps. We accept that: each
 *    test wires ONCE and uses a DISTINCT paneId, so accumulated subscriptions only ever
 *    coalesce onto the same per-paneId timer (scheduleFlush dedupes by paneId) — an
 *    extra subscription can never turn one debounced push into two.
 *  - The GUARD test is ORDER-INDEPENDENT: it proves the guard by spying on the stores'
 *    `subscribe` methods and asserting neither is called (no store mutation, no timer
 *    advance). So a lingering subscription from an earlier test can never drive an
 *    unguarded flush that throws on the undefined `terminalState.push`.
 *  - Fake timers are installed per test and torn down in afterEach; `useRealTimers()`
 *    uninstalls the clock so no pending debounce leaks into the next test, and the next
 *    test's fresh `useFakeTimers()` starts from an empty clock.
 */

const blocks = () => useBlocksStore.getState()

/** Seed layoutStore with one session whose tree is a single pane carrying `cwd`. */
function seedPaneCwd(sessionId: string, paneId: string, cwd: string): void {
  const root: LayoutNode = { type: 'pane', id: paneId, title: 'zsh', kind: 'terminal', cwd }
  useLayoutStore.setState({ bySession: { [sessionId]: { root, activePaneId: paneId } } })
}

describe('wireTerminalStateBridge', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    // Snapshot pristine store state (data + stable action fns) before any test mutates.
    blocksInit = useBlocksStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    // setup.ts stubs a fresh window.pine (with a new push vi.fn) before this hook runs.
    vi.mocked(window.pine.terminalState.push).mockClear()
  })

  afterEach(() => {
    // Restore stores to pristine (replace, not merge) so panes/blocks don't bleed.
    useBlocksStore.setState(blocksInit, true)
    useLayoutStore.setState(layoutInit, true)
    // Uninstall the fake clock: any debounce the resets just scheduled is discarded.
    vi.useRealTimers()
  })

  it('GUARD: does not subscribe when window.pine.terminalState is undefined', () => {
    // Order-independent: prove the guard by asserting NO subscription is created (spying
    // on the store `subscribe` methods) rather than by mutating a store and advancing the
    // clock — so a lingering subscription from an earlier test can never drive an
    // unguarded flush that throws on the undefined `terminalState.push`.
    const blocksSubscribe = vi.spyOn(useBlocksStore, 'subscribe')
    const layoutSubscribe = vi.spyOn(useLayoutStore, 'subscribe')
    try {
      // Simulate a preload that never exposed the terminalState API.
      Reflect.set(window.pine, 'terminalState', undefined)

      expect(() => wireTerminalStateBridge()).not.toThrow()

      expect(blocksSubscribe).not.toHaveBeenCalled()
      expect(layoutSubscribe).not.toHaveBeenCalled()
    } finally {
      blocksSubscribe.mockRestore()
      layoutSubscribe.mockRestore()
    }
  })

  it('pushes a debounced snapshot 100ms after a blocksStore mutation, matching store state', () => {
    const push = vi.mocked(window.pine.terminalState.push)
    wireTerminalStateBridge()

    // resetPane bumps generation to 1 (proves generation is read from the store, not 0),
    // commandStart then commits one running block.
    blocks().resetPane('pane-b')
    blocks().commandStart('pane-b', 5)

    // Nothing before the debounce elapses.
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
    const push = vi.mocked(window.pine.terminalState.push)
    wireTerminalStateBridge()

    // Three mutations, each inside the previous 100ms window — every one resets the timer.
    blocks().commandStart('pane-c', 1)
    vi.advanceTimersByTime(50)
    expect(push).not.toHaveBeenCalled()

    blocks().commandEnd('pane-c', 2, 0) // block1 completes (exit 0), resets the timer
    vi.advanceTimersByTime(50)
    expect(push).not.toHaveBeenCalled()

    blocks().commandStart('pane-c', 3) // block2 starts running, resets the timer again
    vi.advanceTimersByTime(100)

    // Despite three mutations spanning 200ms, exactly ONE push — of the final state.
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-c',
      generation: 0,
      cwd: undefined,
      running: true, // block2 in-flight
      blockCount: 2,
      lastExitCode: 0, // block1's exit; block2 (null) skipped
    })
  })

  it("reflects the pane's layoutStore cwd, and a cwd-only change schedules a push", () => {
    const push = vi.mocked(window.pine.terminalState.push)
    wireTerminalStateBridge()

    // Pane exists in the layout tree with a cwd; give it one block too.
    seedPaneCwd('sess-d', 'pane-d', '/work/d')
    blocks().commandStart('pane-d', 1)
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

    // A cwd change alone (no blocksStore mutation) must schedule a fresh push.
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
    const push = vi.mocked(window.pine.terminalState.push)
    wireTerminalStateBridge()

    // block1 completes with exit 5; block2 starts and stays in-flight (exitCode null).
    blocks().commandStart('pane-e', 1)
    blocks().commandEnd('pane-e', 2, 5)
    blocks().commandStart('pane-e', 3)
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-e',
      generation: 0,
      cwd: undefined,
      running: true, // running['pane-e'] holds block2's id
      blockCount: 2,
      lastExitCode: 5, // block2 (null) skipped, block1's 5 returned
    })
  })

  it('reports running:false once the only block has completed (running[] cleared)', () => {
    const push = vi.mocked(window.pine.terminalState.push)
    wireTerminalStateBridge()

    // One block that starts then completes with exit 0: commandEnd clears running['pane-f'].
    blocks().commandStart('pane-f', 1)
    blocks().commandEnd('pane-f', 2, 0)
    vi.advanceTimersByTime(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      paneId: 'pane-f',
      generation: 0,
      cwd: undefined,
      running: false, // running['pane-f'] is undefined after commandEnd
      blockCount: 1,
      lastExitCode: 0,
    })
  })
})
