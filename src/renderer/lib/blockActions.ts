import type { Terminal } from '@xterm/xterm'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { readBufferText } from './blockText'
import {
  type StepDirection,
  blockSpan,
  isIdlePrompt,
  scrollTargetFor,
  stepSelection,
} from './blocks'
import { inputEditorFor, terminalFor } from './terminalHandles'

export type BlockPart = 'command' | 'output' | 'both'

function findBlock(paneId: string, blockId?: string): CommandBlock | undefined {
  const s = useBlocksStore.getState()
  const list = s.byPane[paneId] ?? []
  const id = blockId ?? s.selected[paneId]
  return id ? list.find((b) => b.id === id) : list[list.length - 1]
}

export function blockOutput(term: Terminal, block: CommandBlock): string {
  const buf = term.buffer.normal
  const to = block.endLine
    ? { line: block.endLine.line, col: block.endCol }
    : { line: buf.baseY + buf.cursorY, col: buf.cursorX }
  return readBufferText(buf, { line: block.outputStartLine.line, col: 0 }, to)
}

export function blockText(term: Terminal, block: CommandBlock, part: BlockPart): string {
  if (part === 'command') return block.command
  const output = blockOutput(term, block)
  if (part === 'output') return output
  return output ? `${block.command}\n${output}` : block.command
}

export async function copyBlock(
  paneId: string,
  part: BlockPart,
  blockId?: string,
): Promise<boolean> {
  const term = terminalFor(paneId)
  const block = findBlock(paneId, blockId)
  if (!term || !block) return false
  await navigator.clipboard.writeText(blockText(term, block, part))
  return true
}

export function selectedBlockOutput(paneId: string): { command: string; output: string } | null {
  const term = terminalFor(paneId)
  const blockId = useBlocksStore.getState().selected[paneId]
  const block = blockId ? findBlock(paneId, blockId) : undefined
  if (!term || !block) return null
  return { command: block.command, output: blockOutput(term, block) }
}

export function revealBlock(paneId: string, block: CommandBlock): void {
  const term = terminalFor(paneId)
  if (!term) return
  const buf = term.buffer.normal
  const span = blockSpan(block, buf.baseY + buf.cursorY)
  const target = scrollTargetFor(span, buf.viewportY, term.rows)
  if (target !== null) term.scrollToLine(target)
}

export function stepBlock(paneId: string, dir: StepDirection): string | null {
  const s = useBlocksStore.getState()
  const list = s.byPane[paneId] ?? []
  const ids = list.map((b) => b.id)
  const next = stepSelection(ids, s.selected[paneId], dir)
  if (!next) return null
  s.select(paneId, next)
  const block = list.find((b) => b.id === next)
  if (block) revealBlock(paneId, block)
  return next
}

export function canTypeInto(paneId: string): boolean {
  return Boolean(terminalFor(paneId)) && isIdlePrompt(useBlocksStore.getState(), paneId)
}

export function insertCommand(paneId: string, command: string, execute = false): boolean {
  const term = terminalFor(paneId)
  if (!term || !command || !canTypeInto(paneId)) return false
  const editor = execute ? undefined : inputEditorFor(paneId)
  if (editor) {
    editor.insert(command)
    return true
  }
  term.paste(command)
  if (execute) window.ostia.pty.write(paneId, '\r')
  term.focus()
  return true
}

export const RUN_WHEN_IDLE_TIMEOUT_MS = 30_000

function atReadyPrompt(paneId: string): boolean {
  return canTypeInto(paneId) && Boolean(useBlocksStore.getState().drafts[paneId]?.inputLine)
}

export function runWhenIdle(
  paneId: string,
  command: string,
  timeoutMs = RUN_WHEN_IDLE_TIMEOUT_MS,
): () => void {
  let done = false
  const stop = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    unsubscribe()
  }
  const attempt = (): void => {
    if (done || !atReadyPrompt(paneId)) return
    stop()
    const ok = insertCommand(paneId, command, true)
    console.log('[race] runWhenIdle insert', paneId, Date.now(), ok)
  }
  console.log('[race] runWhenIdle start', paneId, Date.now())
  const unsubscribe = useBlocksStore.subscribe(attempt)
  const timer = setTimeout(stop, timeoutMs)
  attempt()
  return stop
}

export function rerunBlock(paneId: string, blockId?: string): boolean {
  const block = findBlock(paneId, blockId)
  if (!block) return false
  return insertCommand(paneId, block.command, true)
}
