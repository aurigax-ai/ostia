import { findPane, paneIds } from '../layout/tree'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'

const DEBOUNCE_MS = 100

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function findCwd(paneId: string): string | undefined {
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    const pane = findPane(layout.root, paneId)
    if (pane) return pane.cwd
  }
  return undefined
}

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

function paneIdsInBlocks(state: ReturnType<typeof useBlocksStore.getState>): Set<string> {
  return new Set([
    ...Object.keys(state.byPane),
    ...Object.keys(state.running),
    ...Object.keys(state.gen),
  ])
}

export function wireTerminalStateBridge(): void {
  if (!window.pine?.terminalState) return

  useBlocksStore.subscribe((state, prev) => {
    const live = paneIdsInBlocks(state)
    const ids = new Set([...live, ...paneIdsInBlocks(prev)])
    for (const id of ids) {
      if (!live.has(id)) {
        clearTimeout(timers.get(id))
        timers.delete(id)
        continue
      }
      if (
        state.byPane[id] !== prev.byPane[id] ||
        state.running[id] !== prev.running[id] ||
        state.gen[id] !== prev.gen[id]
      ) {
        scheduleFlush(id)
      }
    }
  })

  let prevCwd = new Map<string, string | undefined>()
  useLayoutStore.subscribe((state) => {
    const next = new Map<string, string | undefined>()
    for (const layout of Object.values(state.byWorkspace)) {
      for (const id of paneIds(layout.root)) next.set(id, findPane(layout.root, id)?.cwd)
    }
    for (const [id, cwd] of next) {
      if (prevCwd.get(id) !== cwd) scheduleFlush(id)
    }
    prevCwd = next
  })
}
