import {
  CHAT_CONTEXT_TEXT_MAX,
  type ChatContextItem,
  type ChatContextKind,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { editorPositionOf } from '@/lib/files/editorPositions'
import { baseName } from '@/lib/files/fileTree'
import { allPanes, findPane } from '@/lib/layout/tree'
import { blockText } from '@/lib/terminal/blockActions'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { type LiveSelection, useLiveSelectionStore } from '@/stores/terminal/liveSelectionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRecencyStore } from '@/stores/workspaces/paneRecencyStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const OUTPUT_TAIL_MAX = 8000

export type AskContextKind = Extract<
  ChatContextKind,
  'cwd' | 'editor' | 'output' | 'selection' | 'pane'
>

export const ASK_CONTEXT_ORDER: readonly AskContextKind[] = [
  'cwd',
  'editor',
  'output',
  'selection',
  'pane',
]

export function tail(text: string, max = OUTPUT_TAIL_MAX): string {
  return text.length > max ? text.slice(text.length - max) : text
}

export function workspaceTerminal(
  workspaceId: string | null | undefined,
): { paneId: string; cwd?: string } | null {
  const id = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
  const layout = id ? useLayoutStore.getState().byWorkspace[id] : undefined
  if (!layout) return null
  const active = findPane(layout.root, layout.activePaneId)
  const touched = usePaneRecencyStore.getState().touchedAt
  const terminals = allPanes(layout.root).filter((p) => p.kind === 'terminal' && !p.hibernated)
  const pane =
    active?.kind === 'terminal'
      ? active
      : ([...terminals].sort((a, b) => (touched[b.id] ?? 0) - (touched[a.id] ?? 0))[0] ?? null)
  if (!pane) return null
  return pane.cwd ? { paneId: pane.id, cwd: pane.cwd } : { paneId: pane.id }
}

function workspaceEditorFile(
  workspaceId: string | null | undefined,
): { paneId: string; file: string } | null {
  const id = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
  const layout = id ? useLayoutStore.getState().byWorkspace[id] : undefined
  if (!layout) return null
  const touched = usePaneRecencyStore.getState().touchedAt
  const editors = allPanes(layout.root).filter(
    (p) => p.kind === 'editor' && p.filePath && !isRemotePath(p.filePath),
  )
  const active = editors.find((p) => p.id === layout.activePaneId)
  const pane = active ?? [...editors].sort((a, b) => (touched[b.id] ?? 0) - (touched[a.id] ?? 0))[0]
  return pane?.filePath ? { paneId: pane.id, file: pane.filePath } : null
}

export function useWorkspaceEditorFile(workspaceId: string | null | undefined): string | null {
  useLayoutStore((state) => state.byWorkspace)
  usePaneRecencyStore((state) => state.touchedAt)
  useWorkspacesStore((state) => state.activeWorkspaceId)
  return workspaceEditorFile(workspaceId)?.file ?? null
}

function editorFileContext(
  workspaceId: string | null | undefined,
  label: string,
): ChatContextItem | null {
  const open = workspaceEditorFile(workspaceId)
  if (!open) return null
  const position = editorPositionOf(open.paneId)
  const cursor = position?.file === open.file ? `, cursor at line ${position.line}` : ''
  return {
    kind: 'editor',
    label: `${label} ${baseName(open.file)}`,
    text: `The file the user has open in the editor${cursor}.`,
    path: open.file,
  }
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

export function askContextOptions(
  labels: Record<AskContextKind, string>,
  workspaceId?: string | null,
): AskContextOptions {
  const out: AskContextOptions = {}
  const editor = editorFileContext(workspaceId, labels.editor)
  if (editor) out.editor = editor
  const pane = workspaceTerminal(workspaceId)
  if (!pane) return out
  if (pane.cwd) out.cwd = { kind: 'cwd', label: labels.cwd, text: pane.cwd }
  const block = lastFinishedBlock(pane.paneId)
  if (block)
    out.output = { kind: 'output', label: labels.output, text: blockContext(pane.paneId, block) }
  const info = paneInfo(pane.paneId)
  if (info) out.pane = { kind: 'pane', label: labels.pane, text: info }
  return out
}

export function selectionRef(selection: LiveSelection): string | null {
  const { source } = selection
  if (source.kind !== 'editor') return null
  const name = baseName(source.file)
  return source.startLine === source.endLine
    ? `${name}:${source.startLine}`
    : `${name}:${source.startLine}-${source.endLine}`
}

export function liveSelectionContext(
  workspaceId: string | null | undefined,
  label: string,
): ChatContextItem | null {
  const selection = workspaceId
    ? useLiveSelectionStore.getState().byWorkspace[workspaceId]
    : undefined
  if (!selection) return null
  const ref = selectionRef(selection)
  const item: ChatContextItem = {
    kind: 'selection',
    label: ref ? `${label} ${ref}` : label,
    text: tail(selection.text, CHAT_CONTEXT_TEXT_MAX),
  }
  const { source } = selection
  if (source.kind !== 'editor') return item
  return { ...item, path: source.file, startLine: source.startLine, endLine: source.endLine }
}

const SHELL_LANGUAGES = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'fish'])

export function isShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.toLowerCase())
}

export function blockOutputContext(
  paneId: string,
  blockId: string | undefined,
  label: string,
): ChatContextItem | null {
  const list = useBlocksStore.getState().byPane[paneId] ?? []
  const block = blockId ? list.find((b) => b.id === blockId) : lastFinishedBlock(paneId)
  if (!block) return null
  return { kind: 'output', label, text: blockContext(paneId, block) }
}

export function terminalSelectionContext(paneId: string, label: string): ChatContextItem | null {
  const selection = terminalFor(paneId)?.getSelection() ?? ''
  return selection.trim() ? { kind: 'selection', label, text: tail(selection) } : null
}

export function lastBlockCommand(paneId: string): string | null {
  return lastFinishedBlock(paneId)?.command ?? null
}

export async function fileAttachment(path: string, label: string): Promise<ChatContextItem | null> {
  const res = await window.ostia.fs.read(path).catch(() => null)
  if (!res?.ok) return null
  const { text } = res
  const item: ChatContextItem = { kind: 'file', label, text: text.slice(0, CHAT_CONTEXT_TEXT_MAX) }
  return path.startsWith('/') ? { ...item, path } : item
}

type ExplainSourceKind = 'selection' | 'block' | 'output'

export interface ExplainSource {
  value: ExplainSourceKind
  item: ChatContextItem
}

export function explainSources(
  workspaceId: string | null | undefined,
  labels: {
    selection: string
    block: (command: string) => string
    output: (command: string) => string
  },
): ExplainSource[] {
  const pane = workspaceTerminal(workspaceId)
  if (!pane) return []
  const out: ExplainSource[] = []
  const selection = terminalSelectionContext(pane.paneId, labels.selection)
  if (selection) out.push({ value: 'selection', item: selection })
  const blocks = useBlocksStore.getState()
  const selectedId = blocks.selected[pane.paneId]
  const chosen = selectedId
    ? blocks.byPane[pane.paneId]?.find((b) => b.id === selectedId)
    : undefined
  if (chosen) {
    const label = labels.block(chosen.command)
    out.push({
      value: 'block',
      item: { kind: 'output', label, text: blockContext(pane.paneId, chosen) },
    })
  }
  const last = lastFinishedBlock(pane.paneId)
  if (last && last.id !== chosen?.id) {
    const label = labels.output(last.command)
    out.push({
      value: 'output',
      item: { kind: 'output', label, text: blockContext(pane.paneId, last) },
    })
  }
  return out
}
