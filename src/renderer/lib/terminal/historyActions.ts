import type { CommandBlock } from '@/stores/terminal/blocksStore'
import { useHistoryViewStore } from '@/stores/terminal/historyViewStore'
import { logicalLinesFrom } from './historyPages'
import type { OstiaTerminal } from './ostiaTerminal'

export function liveLogicalLines(term: OstiaTerminal): number {
  return logicalLinesFrom(term.buffer.normal, 0)
}

export function showHistoryAboveLive(paneId: string): void {
  useHistoryViewStore.getState().show(paneId, { kind: 'aboveLive' })
}

export function isSpilled(block: CommandBlock): block is CommandBlock & { seq: number } {
  return block.seq !== undefined && block.outputStartLine.line < 0
}

export async function showSpilledBlock(
  paneId: string,
  block: CommandBlock & { seq: number },
): Promise<boolean> {
  const range = await window.ostia.pty.historyBlock(paneId, block.seq, block.command)
  if (!range) return false
  useHistoryViewStore.getState().show(paneId, { kind: 'line', line: range.start })
  return true
}

export async function spilledBlockOutput(
  paneId: string,
  block: CommandBlock & { seq: number },
): Promise<string> {
  return (await window.ostia.pty.blockOutput(paneId, block.seq, block.command)) ?? ''
}
