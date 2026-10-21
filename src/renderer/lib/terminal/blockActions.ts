import { releasePhoneHold } from '@/lib/terminal/phoneHold'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import {
  blockSpan,
  isIdlePrompt,
  type StepDirection,
  scrollTargetFor,
  stepSelection,
} from './blocks'
import { readBufferText } from './blockText'
import { isSpilled, showSpilledBlock, spilledBlockOutput } from './historyActions'
import type { OstiaTerminal as Terminal } from './ostiaTerminal'
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

function partText(command: string, output: string, part: BlockPart): string {
  if (part === 'command') return command
  if (part === 'output') return output
  return output ? `${command}\n${output}` : command
}

export function blockText(term: Terminal, block: CommandBlock, part: BlockPart): string {
  return partText(block.command, part === 'command' ? '' : blockOutput(term, block), part)
}

export async function copyBlock(
  paneId: string,
  part: BlockPart,
  blockId?: string,
): Promise<boolean> {
  const term = terminalFor(paneId)
  const block = findBlock(paneId, blockId)
  if (!term || !block) return false
  const text =
    part !== 'command' && isSpilled(block)
      ? partText(block.command, await spilledBlockOutput(paneId, block), part)
      : blockText(term, block, part)
  await navigator.clipboard.writeText(text)
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
  if (isSpilled(block)) {
    void showSpilledBlock(paneId, block)
    return
  }
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

function runCommand(paneId: string, command: string): boolean {
  const term = terminalFor(paneId)
  if (!term || !command || !canTypeInto(paneId)) return false
  releasePhoneHold(paneId)
  term.paste(command)
  window.ostia.pty.write(paneId, '\r')
  return true
}

export function insertCommand(paneId: string, command: string, execute = false): boolean {
  const term = terminalFor(paneId)
  if (!term || !command || !canTypeInto(paneId)) return false
  const editor = execute ? undefined : inputEditorFor(paneId)
  if (editor) {
    editor.insert(command)
    return true
  }
  if (execute) runCommand(paneId, command)
  else term.paste(command)
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
  timeoutMs: number | null = RUN_WHEN_IDLE_TIMEOUT_MS,
  allowed: () => boolean | Promise<boolean> = () => true,
  onGiveUp: () => void = () => {},
  onTyped: () => void = () => {},
): () => void {
  let done = false
  const stop = (): void => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
  const attempt = (): void => {
    if (done || !atReadyPrompt(paneId)) return
    stop()
    const type = (ok: boolean): void => {
      if (!ok || !runCommand(paneId, command)) onGiveUp()
      else onTyped()
    }
    const verdict = allowed()
    if (typeof verdict === 'boolean') type(verdict)
    else
      void verdict.then(
        (ok) => type(ok && atReadyPrompt(paneId)),
        () => onGiveUp(),
      )
  }
  const unsubscribe = useBlocksStore.subscribe(attempt)
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          stop()
          onGiveUp()
        }, timeoutMs)
  attempt()
  return stop
}

export function rerunBlock(paneId: string, blockId?: string): boolean {
  const typed = findBlock(paneId, blockId)?.typedCommand
  return typed ? insertCommand(paneId, typed, true) : false
}
