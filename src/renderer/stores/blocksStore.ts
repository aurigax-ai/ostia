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
  promptStart: (paneId: string, line: LineAnchor, cwd: string | null) => void
  promptEnd: (paneId: string, line: LineAnchor) => void
  commandStart: (paneId: string, line: LineAnchor) => void
  commandEnd: (paneId: string, line: LineAnchor, exitCode: number) => void
  resetPane: (paneId: string) => void
  dropPane: (paneId: string) => void
}

export const useBlocksStore = create<BlocksState>((set) => ({
  byPane: {},
  drafts: {},
  running: {},
  gen: {},

  promptStart: (paneId, line, cwd) =>
    set((s) => ({ drafts: { ...s.drafts, [paneId]: { promptLine: line, inputLine: null, cwd } } })),

  promptEnd: (paneId, line) =>
    set((s) => {
      const draft = s.drafts[paneId]
      if (!draft) return s
      return { drafts: { ...s.drafts, [paneId]: { ...draft, inputLine: line } } }
    }),

  commandStart: (paneId, line) =>
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
        exitCode: null,
        cwd: draft.cwd,
        startedAt: Date.now(),
        endedAt: null,
      }
      const list = [...prev, block].slice(-MAX_BLOCKS_PER_PANE)
      return {
        byPane: { ...s.byPane, [paneId]: list },
        running: { ...s.running, [paneId]: block.id },
        drafts: { ...s.drafts, [paneId]: undefined },
      }
    }),

  commandEnd: (paneId, line, exitCode) =>
    set((s) => {
      const runningId = s.running[paneId]
      if (!runningId) return s
      const list = s.byPane[paneId] ?? []
      const idx = list.findIndex((b) => b.id === runningId)
      if (idx === -1) return s
      const next = list.slice()
      next[idx] = { ...next[idx], endLine: line, exitCode, endedAt: Date.now() }
      return {
        byPane: { ...s.byPane, [paneId]: next },
        running: { ...s.running, [paneId]: undefined },
      }
    }),

  resetPane: (paneId) =>
    set((s) => ({
      byPane: { ...s.byPane, [paneId]: [] },
      drafts: { ...s.drafts, [paneId]: undefined },
      running: { ...s.running, [paneId]: undefined },
      gen: { ...s.gen, [paneId]: (s.gen[paneId] ?? 0) + 1 },
    })),

  dropPane: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane || paneId in s.drafts || paneId in s.running || paneId in s.gen)) {
        return s
      }
      const { [paneId]: _b, ...byPane } = s.byPane
      const { [paneId]: _d, ...drafts } = s.drafts
      const { [paneId]: _r, ...running } = s.running
      const { [paneId]: _g, ...gen } = s.gen
      return { byPane, drafts, running, gen }
    }),
}))
