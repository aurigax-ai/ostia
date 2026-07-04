/**
 * Slice 7: a passive observer that mirrors this window's terminal state (per pane:
 * cwd, is-a-command-running, block count, last exit code) to main, so main (and the
 * control socket / `pine` CLI) can answer "what is pane X doing" without reaching
 * into renderer state.
 *
 * Design (spec Codex A.5/F6): push a COMPACT snapshot, not raw store mutations, so
 * main keeps a small per-pane read-model instead of shadowing the whole blocksStore.
 * Debounced per pane (~100ms) since blocksStore/layoutStore can update in bursts
 * (fast keystrokes, prompt redraws). NOT full replay/live-phase precision (parked —
 * see task report) — the debounced snapshot of blocksStore's CURRENT state is good
 * enough for MVP.
 *
 * Purely a subscriber: never calls into blocksStore/layoutStore setters, so wiring
 * this in changes no terminal/UI behavior.
 */
import { findPane, paneIds } from '../layout/tree'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'

const DEBOUNCE_MS = 100

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** cwd of `paneId`, searched across every session's layout tree (bridge only knows paneId). */
function findCwd(paneId: string): string | undefined {
  for (const layout of Object.values(useLayoutStore.getState().bySession)) {
    const pane = findPane(layout.root, paneId)
    if (pane) return pane.cwd
  }
  return undefined
}

/** The exit code of the most recently COMPLETED block (skips the in-flight one, if any). */
function lastExitCode(list: CommandBlock[]): number | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const code = list[i].exitCode
    if (code !== null) return code
  }
  return undefined
}

function flush(paneId: string): void {
  const blocks = useBlocksStore.getState()
  const list = blocks.byPane[paneId] ?? []
  window.pine.terminalState.push({
    paneId,
    generation: blocks.gen[paneId] ?? 0,
    cwd: findCwd(paneId),
    running: blocks.running[paneId] !== undefined,
    blockCount: list.length,
    lastExitCode: lastExitCode(list),
  })
}

function scheduleFlush(paneId: string): void {
  const existing = timers.get(paneId)
  if (existing) clearTimeout(existing)
  timers.set(
    paneId,
    setTimeout(() => {
      timers.delete(paneId)
      flush(paneId)
    }, DEBOUNCE_MS),
  )
}

/** Every pane id `blocksStore` currently touches (union of its per-pane record keys). */
function paneIdsInBlocks(state: ReturnType<typeof useBlocksStore.getState>): Set<string> {
  return new Set([
    ...Object.keys(state.byPane),
    ...Object.keys(state.running),
    ...Object.keys(state.gen),
  ])
}

/** Wire the terminal-state mirror. Call once at startup, after `wireCommandBridge()`. */
export function wireTerminalStateBridge(): void {
  if (!window.pine?.terminalState) return

  useBlocksStore.subscribe((state, prev) => {
    const ids = new Set([...paneIdsInBlocks(state), ...paneIdsInBlocks(prev)])
    for (const id of ids) {
      if (
        state.byPane[id] !== prev.byPane[id] ||
        state.running[id] !== prev.running[id] ||
        state.gen[id] !== prev.gen[id]
      ) {
        scheduleFlush(id)
      }
    }
  })

  // cwd lives in layoutStore (per-session tree), not blocksStore — track it separately so
  // an OSC 7 cwd change (no block mutation) still schedules a fresh push.
  let prevCwd = new Map<string, string | undefined>()
  useLayoutStore.subscribe((state) => {
    const next = new Map<string, string | undefined>()
    for (const layout of Object.values(state.bySession)) {
      for (const id of paneIds(layout.root)) next.set(id, findPane(layout.root, id)?.cwd)
    }
    for (const [id, cwd] of next) {
      if (prevCwd.get(id) !== cwd) scheduleFlush(id)
    }
    prevCwd = next
  })
}
