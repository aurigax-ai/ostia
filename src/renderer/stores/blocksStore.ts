import { create } from 'zustand'

/**
 * A Warp-style command block, built from the OSC 133 marks a shell-integration hook
 * emits around each prompt/command (see `src/main/shellIntegration.ts`). Line numbers are
 * ABSOLUTE xterm buffer lines (`baseY + cursorY` at the moment the mark arrived), so a
 * block's position survives scrollback — Blocks.tsx re-maps them to pixels on every render.
 */
export interface CommandBlock {
  id: string
  paneId: string
  /** Buffer line where the prompt started (OSC 133;A). */
  promptLine: number
  /** Buffer line where the prompt text ended / command input began (OSC 133;B), if seen. */
  inputLine: number | null
  /** Buffer line where the command started executing (OSC 133;C) — the block's top edge. */
  outputStartLine: number
  /** Buffer line where the command finished (OSC 133;D). Null while still running. */
  endLine: number | null
  /** Exit code from OSC 133;D;<code>. Null while running. */
  exitCode: number | null
  /** cwd (from the most recent OSC 7) at the time the prompt for this block started. */
  cwd: string | null
  startedAt: number
  endedAt: number | null
}

/** Cap kept per pane so a long-lived session doesn't grow the block list unboundedly. */
const MAX_BLOCKS_PER_PANE = 200

interface Draft {
  promptLine: number
  inputLine: number | null
  cwd: string | null
}

interface BlocksState {
  byPane: Record<string, CommandBlock[] | undefined>
  /** In-flight draft (between A and C) per pane — not yet a committed block. */
  drafts: Record<string, Draft | undefined>
  /** id of the block currently executing (between C and D) per pane. */
  running: Record<string, string | undefined>
  /**
   * Per-pane generation counter, bumped by `resetPane`. Lets a consumer outside this
   * store (Slice 7's terminal-state bridge) tell a stale pre-reset snapshot from a
   * fresh post-reset one without inspecting block contents.
   */
  gen: Record<string, number | undefined>
  /** OSC 133;A — a new prompt started. */
  promptStart: (paneId: string, line: number, cwd: string | null) => void
  /** OSC 133;B — the prompt text ended (command input starts here). */
  promptEnd: (paneId: string, line: number) => void
  /** OSC 133;C — a command started executing; commits the draft as a real block. */
  commandStart: (paneId: string, line: number) => void
  /** OSC 133;D;<exit> — the running command finished. */
  commandEnd: (paneId: string, line: number, exitCode: number) => void
  /** Drop a pane's blocks (before a remount replay re-parses OSC 133 from scratch). */
  resetPane: (paneId: string) => void
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
      // If a prior block never got its OSC 133;D (lost to buffer truncation / a dropped
      // chunk), close it here so Blocks.tsx stops treating it as still-running forever.
      const staleId = s.running[paneId]
      if (staleId) {
        prev = prev.map((b) =>
          b.id === staleId && b.endLine === null ? { ...b, endLine: line, endedAt: Date.now() } : b,
        )
      }
      const block: CommandBlock = {
        id: `${paneId}-${line}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
}))
