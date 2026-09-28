import { create } from 'zustand'

export interface LineAnchor {
  readonly line: number
}

export interface CommandBlock {
  id: string
  paneId: string
  promptLine: LineAnchor
  inputLine: LineAnchor | null
  outputStartLine: LineAnchor
  endLine: LineAnchor | null
  endCol: number
  command: string
  exitCode: number | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
}

const MAX_BLOCKS_PER_PANE = 200

interface Draft {
  promptLine: LineAnchor
  inputLine: LineAnchor | null
  cwd: string | null
}

interface BlocksState {
  byPane: Record<string, CommandBlock[] | undefined>
  drafts: Record<string, Draft | undefined>
  running: Record<string, string | undefined>
  gen: Record<string, number | undefined>
  selected: Record<string, string | undefined>
  promptStart: (paneId: string, line: LineAnchor, cwd: string | null) => void
  promptEnd: (paneId: string, line: LineAnchor) => void
  commandStart: (paneId: string, line: LineAnchor, command?: string) => void
  commandEnd: (paneId: string, line: LineAnchor, exitCode: number, endCol?: number) => void
  select: (paneId: string, blockId: string | null) => void
  resetPane: (paneId: string) => void
  dropPane: (paneId: string) => void
}

export const useBlocksStore = create<BlocksState>((set) => ({
  byPane: {},
  drafts: {},
  running: {},
  gen: {},
  selected: {},

  promptStart: (paneId, line, cwd) =>
    set((s) => ({ drafts: { ...s.drafts, [paneId]: { promptLine: line, inputLine: null, cwd } } })),

  promptEnd: (paneId, line) =>
    set((s) => {
      const draft = s.drafts[paneId]
      if (!draft) return s
      return { drafts: { ...s.drafts, [paneId]: { ...draft, inputLine: line } } }
    }),

  commandStart: (paneId, line, command = '') =>
    set((s) => {
      const draft = s.drafts[paneId] ?? { promptLine: line, inputLine: line, cwd: null }
      let prev = s.byPane[paneId] ?? []
      const staleId = s.running[paneId]
      if (staleId) {
        prev = prev.map((b) =>
          b.id === staleId && b.endLine === null ? { ...b, endLine: line, endedAt: Date.now() } : b,
        )
      }
      const block: CommandBlock = {
        id: `${paneId}-${line.line}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        paneId,
        promptLine: draft.promptLine,
        inputLine: draft.inputLine,
        outputStartLine: line,
        endLine: null,
        endCol: 0,
        command,
        exitCode: null,
        cwd: draft.cwd,
        startedAt: Date.now(),
        endedAt: null,
      }
      const list = [...prev, block].slice(-MAX_BLOCKS_PER_PANE)
      const selectedId = s.selected[paneId]
      const selectionKept = !selectedId || list.some((b) => b.id === selectedId)
      return {
        ...(selectionKept ? {} : { selected: { ...s.selected, [paneId]: undefined } }),
        byPane: { ...s.byPane, [paneId]: list },
        running: { ...s.running, [paneId]: block.id },
        drafts: { ...s.drafts, [paneId]: undefined },
      }
    }),

  commandEnd: (paneId, line, exitCode, endCol = 0) =>
    set((s) => {
      const runningId = s.running[paneId]
      if (!runningId) return s
      const list = s.byPane[paneId] ?? []
      const idx = list.findIndex((b) => b.id === runningId)
      if (idx === -1) return s
      const next = list.slice()
      next[idx] = { ...next[idx], endLine: line, endCol, exitCode, endedAt: Date.now() }
      return {
        byPane: { ...s.byPane, [paneId]: next },
        running: { ...s.running, [paneId]: undefined },
      }
    }),

  select: (paneId, blockId) =>
    set((s) => {
      const next = blockId ?? undefined
      if (s.selected[paneId] === next) return s
      if (next && !s.byPane[paneId]?.some((b) => b.id === next)) return s
      return { selected: { ...s.selected, [paneId]: next } }
    }),

  resetPane: (paneId) =>
    set((s) => ({
      byPane: { ...s.byPane, [paneId]: [] },
      selected: { ...s.selected, [paneId]: undefined },
      drafts: { ...s.drafts, [paneId]: undefined },
      running: { ...s.running, [paneId]: undefined },
      gen: { ...s.gen, [paneId]: (s.gen[paneId] ?? 0) + 1 },
    })),

  dropPane: (paneId) =>
    set((s) => {
      if (
        !(
          paneId in s.byPane ||
          paneId in s.drafts ||
          paneId in s.running ||
          paneId in s.gen ||
          paneId in s.selected
        )
      ) {
        return s
      }
      const { [paneId]: _b, ...byPane } = s.byPane
      const { [paneId]: _d, ...drafts } = s.drafts
      const { [paneId]: _r, ...running } = s.running
      const { [paneId]: _g, ...gen } = s.gen
      const { [paneId]: _s, ...selected } = s.selected
      return { byPane, drafts, running, gen, selected }
    }),
}))
