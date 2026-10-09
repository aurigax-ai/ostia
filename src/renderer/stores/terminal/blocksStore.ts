import type { ResumableAgent } from '@shared/agents/agentResume'
import { create } from 'zustand'

export interface LineAnchor {
  readonly line: number
  dispose?(): void
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
  remote: boolean
}

interface BlocksState {
  byPane: Record<string, CommandBlock[] | undefined>
  drafts: Record<string, Draft | undefined>
  running: Record<string, string | undefined>
  gen: Record<string, number | undefined>
  selected: Record<string, string | undefined>
  agentBlocks: Record<string, { blockId: string; agent: ResumableAgent } | undefined>
  markAgent: (paneId: string, agent: ResumableAgent) => void
  promptStart: (paneId: string, line: LineAnchor, cwd: string | null, remote?: boolean) => void
  promptEnd: (paneId: string, line: LineAnchor) => void
  commandStart: (paneId: string, line: LineAnchor, command?: string) => void
  commandEnd: (
    paneId: string,
    line: LineAnchor,
    exitCode: number,
    endCol?: number,
    wholeCommand?: string,
  ) => void
  select: (paneId: string, blockId: string | null) => void
  resetPane: (paneId: string) => void
  dropPane: (paneId: string) => void
}

type Anchored = Pick<BlocksState, 'byPane' | 'drafts'>

function paneAnchors(s: Anchored, paneId: string): Set<LineAnchor> {
  const anchors = new Set<LineAnchor>()
  for (const b of s.byPane[paneId] ?? []) {
    anchors.add(b.promptLine)
    anchors.add(b.outputStartLine)
    if (b.inputLine) anchors.add(b.inputLine)
    if (b.endLine) anchors.add(b.endLine)
  }
  const draft = s.drafts[paneId]
  if (draft) {
    anchors.add(draft.promptLine)
    if (draft.inputLine) anchors.add(draft.inputLine)
  }
  return anchors
}

function releaseDropped(
  before: Anchored,
  after: Anchored,
  paneId: string,
  incoming: LineAnchor[] = [],
): void {
  const live = paneAnchors(after, paneId)
  for (const anchor of [...paneAnchors(before, paneId), ...incoming]) {
    if (!live.has(anchor)) anchor.dispose?.()
  }
}

export const useBlocksStore = create<BlocksState>((set, get) => ({
  byPane: {},
  drafts: {},
  running: {},
  gen: {},
  selected: {},
  agentBlocks: {},

  markAgent: (paneId, agent) =>
    set((s) => {
      const blockId = s.running[paneId]
      const current = s.agentBlocks[paneId]
      if (!blockId || (current?.blockId === blockId && current.agent === agent)) return s
      return { agentBlocks: { ...s.agentBlocks, [paneId]: { blockId, agent } } }
    }),

  promptStart: (paneId, line, cwd, remote = false) => {
    const before = get()
    set((s) => ({
      drafts: { ...s.drafts, [paneId]: { promptLine: line, inputLine: null, cwd, remote } },
    }))
    releaseDropped(before, get(), paneId)
  },

  promptEnd: (paneId, line) => {
    const before = get()
    set((s) => {
      const draft = s.drafts[paneId]
      if (!draft) return s
      return { drafts: { ...s.drafts, [paneId]: { ...draft, inputLine: line } } }
    })
    releaseDropped(before, get(), paneId)
  },

  commandStart: (paneId, line, command = '') => {
    const before = get()
    set((s) => {
      const draft = s.drafts[paneId] ?? {
        promptLine: line,
        inputLine: line,
        cwd: null,
        remote: false,
      }
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
    })
    releaseDropped(before, get(), paneId)
  },

  commandEnd: (paneId, line, exitCode, endCol, wholeCommand) => {
    const before = get()
    set((s) => {
      const runningId = s.running[paneId]
      if (!runningId) return s
      const list = s.byPane[paneId] ?? []
      const idx = list.findIndex((b) => b.id === runningId)
      if (idx === -1) return s
      const next = list.slice()
      const firstLines = next[idx].command
      next[idx] = {
        ...next[idx],
        command: wholeCommand?.startsWith(`${firstLines}\n`) ? wholeCommand : firstLines,
        endLine: line,
        endCol: endCol ?? 0,
        exitCode,
        endedAt: Date.now(),
      }
      return {
        byPane: { ...s.byPane, [paneId]: next },
        running: { ...s.running, [paneId]: undefined },
      }
    })
    releaseDropped(before, get(), paneId, [line])
  },

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
      agentBlocks: { ...s.agentBlocks, [paneId]: undefined },
    })),

  dropPane: (paneId) =>
    set((s) => {
      if (
        !(
          paneId in s.byPane ||
          paneId in s.drafts ||
          paneId in s.running ||
          paneId in s.gen ||
          paneId in s.selected ||
          paneId in s.agentBlocks
        )
      ) {
        return s
      }
      const { [paneId]: _b, ...byPane } = s.byPane
      const { [paneId]: _d, ...drafts } = s.drafts
      const { [paneId]: _r, ...running } = s.running
      const { [paneId]: _g, ...gen } = s.gen
      const { [paneId]: _s, ...selected } = s.selected
      const { [paneId]: _a, ...agentBlocks } = s.agentBlocks
      return { byPane, drafts, running, gen, selected, agentBlocks }
    }),
}))
