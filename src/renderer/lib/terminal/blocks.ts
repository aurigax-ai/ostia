import type { CommandBlock } from '@/stores/terminal/blocksStore'

export interface LineSpan {
  start: number
  end: number
}

export type StepDirection = 'prev' | 'next'

export function blockSpan(block: CommandBlock, cursorLine: number): LineSpan {
  const prompt = block.promptLine.line
  const start = prompt >= 0 ? prompt : block.outputStartLine.line
  const end = block.endLine ? block.endLine.line + (block.endCol > 0 ? 1 : 0) : cursorLine + 1
  return { start, end: Math.max(end, start + 1) }
}

export function commandLine(block: CommandBlock): number {
  const input = block.inputLine?.line ?? -1
  return input >= 0 ? input : block.promptLine.line
}

export function stepSelection(
  ids: readonly string[],
  current: string | undefined,
  dir: StepDirection,
): string | null {
  if (ids.length === 0) return null
  const idx = current ? ids.indexOf(current) : -1
  if (idx === -1) return dir === 'prev' ? ids[ids.length - 1] : null
  const next = dir === 'prev' ? Math.max(0, idx - 1) : Math.min(ids.length - 1, idx + 1)
  return ids[next]
}

export function scrollTargetFor(span: LineSpan, viewportY: number, rows: number): number | null {
  const visible = span.start >= viewportY && span.start < viewportY + rows
  return visible ? null : span.start
}

export function stickyBlock(
  blocks: readonly CommandBlock[],
  viewportY: number,
  cursorLine: number,
): CommandBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    const line = commandLine(b)
    if (line < 0) continue
    if (line >= viewportY) continue
    const { end } = blockSpan(b, cursorLine)
    return end > viewportY ? b : null
  }
  return null
}

export function isIdlePrompt(
  state: {
    drafts: Record<string, unknown | undefined>
    running: Record<string, string | undefined>
  },
  paneId: string,
): boolean {
  return Boolean(state.drafts[paneId]) && !state.running[paneId]
}

export interface PaneOrigin {
  workspaceId: string
  workspaceName: string
}

export interface HistoryEntry {
  command: string
  paneId: string
  workspaceId: string
  workspaceName: string
  cwd: string | null
  at: number
}

export function collectHistory(
  byPane: Record<string, readonly CommandBlock[] | undefined>,
  origins: ReadonlyMap<string, PaneOrigin>,
): HistoryEntry[] {
  const all: HistoryEntry[] = []
  for (const [paneId, list] of Object.entries(byPane)) {
    const origin = origins.get(paneId)
    if (!origin || !list) continue
    for (const b of [...list].reverse()) {
      const command = b.command.trim()
      if (!command) continue
      all.push({ command, paneId, ...origin, cwd: b.cwd, at: b.startedAt })
    }
  }
  all.sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  return all.filter((e) => {
    if (seen.has(e.command)) return false
    seen.add(e.command)
    return true
  })
}
