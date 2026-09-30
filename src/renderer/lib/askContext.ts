import { CHAT_CONTEXT_TEXT_MAX, type ChatContextItem, type ChatContextKind } from '@shared/assist'
import { findPane } from '../layout/tree'
import { askKey, useAskStore } from '../stores/askStore'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { blockText, canTypeInto, insertCommand } from './blockActions'
import { terminalFor } from './terminalHandles'

export const OUTPUT_TAIL_MAX = 8000

export type AskContextKind = Exclude<ChatContextKind, 'error'>

export const ASK_CONTEXT_ORDER: readonly AskContextKind[] = ['cwd', 'output', 'selection', 'pane']

export function tail(text: string, max = OUTPUT_TAIL_MAX): string {
  return text.length > max ? text.slice(text.length - max) : text
}

export function activeTerminalPane(): { paneId: string; cwd?: string } | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, layout.activePaneId) : null
  if (pane?.kind !== 'terminal') return null
  return pane.cwd ? { paneId: pane.id, cwd: pane.cwd } : { paneId: pane.id }
}

function lastFinishedBlock(paneId: string): CommandBlock | undefined {
  const list = useBlocksStore.getState().byPane[paneId] ?? []
  for (let i = list.length - 1; i >= 0; i--) if (list[i].endLine) return list[i]
  return undefined
}

function blockContext(paneId: string, block: CommandBlock): string {
  const term = terminalFor(paneId)
  return tail(term ? blockText(term, block, 'both') : block.command, CHAT_CONTEXT_TEXT_MAX)
}

function paneInfo(paneId: string): string {
  const { chips, list } = useExtensionsStore.getState()
  return chips
    .filter((chip) => chip.paneId === paneId)
    .map((chip) => {
      const title =
        list.find((e) => e.id === chip.extId)?.paneChips.find((c) => c.id === chip.id)?.title ??
        `${chip.extId}.${chip.id}`
      return `${title}: ${chip.text}`
    })
    .join('\n')
}

export type AskContextOptions = Partial<Record<AskContextKind, ChatContextItem>>

export function askContextOptions(labels: Record<AskContextKind, string>): AskContextOptions {
  const pane = activeTerminalPane()
  if (!pane) return {}
  const out: AskContextOptions = {}
  if (pane.cwd) out.cwd = { kind: 'cwd', label: labels.cwd, text: pane.cwd }
  const block = lastFinishedBlock(pane.paneId)
  if (block)
    out.output = { kind: 'output', label: labels.output, text: blockContext(pane.paneId, block) }
  const selection = terminalFor(pane.paneId)?.getSelection() ?? ''
  if (selection.trim()) {
    out.selection = { kind: 'selection', label: labels.selection, text: tail(selection) }
  }
  const info = paneInfo(pane.paneId)
  if (info) out.pane = { kind: 'pane', label: labels.pane, text: info }
  return out
}

export function failedBlock(paneId: string, blockId: string): CommandBlock | null {
  const block = useBlocksStore.getState().byPane[paneId]?.find((b) => b.id === blockId)
  return block?.endLine && block.exitCode !== null && block.exitCode !== 0 ? block : null
}

export function errorContext(
  paneId: string,
  blockId: string,
  label: string,
): ChatContextItem | null {
  const block = failedBlock(paneId, blockId)
  if (!block) return null
  return {
    kind: 'error',
    label,
    text: `$ ${blockContext(paneId, block)}\n[exit ${block.exitCode}]`,
  }
}

export function explainFailedBlock(
  paneId: string,
  blockId: string,
  text: { prompt: string; label: string },
): boolean {
  const item = errorContext(paneId, blockId, text.label)
  if (!item) return false
  const key = askKey(useWorkspacesStore.getState().activeWorkspaceId)
  useUIStore.getState().leaveSettings()
  useUIStore.getState().openPalette('ask')
  void useAskStore.getState().send(key, text.prompt, [item])
  return true
}

export type InsertOutcome = 'inserted' | 'copied'

export async function insertAtPrompt(text: string): Promise<InsertOutcome> {
  const command = text.replace(/\s+$/, '')
  const pane = activeTerminalPane()
  if (pane && canTypeInto(pane.paneId) && insertCommand(pane.paneId, command)) return 'inserted'
  await navigator.clipboard?.writeText(command).catch(() => undefined)
  return 'copied'
}

const SHELL_LANGUAGES = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'fish'])

export function isShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.toLowerCase())
}
