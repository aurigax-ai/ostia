import { allPanes, findPane } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { usePaneRecencyStore } from '../stores/paneRecencyStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { canTypeInto, insertCommand, runWhenIdle } from './blockActions'
import { isIdlePrompt } from './blocks'
import { openFileInWorkspace } from './openFile'
import { type ReferenceTarget, sendReference } from './sendPick'

export interface TerminalTarget {
  paneId: string
  title: string
  idle: boolean
}

function targetWorkspace(workspaceId: string | null | undefined): string | null {
  return workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
}

export function workspaceTerminals(
  workspaceId: string | null | undefined,
  blocks: { drafts: Record<string, unknown>; running: Record<string, string | undefined> },
): TerminalTarget[] {
  const id = targetWorkspace(workspaceId)
  const layout = id ? useLayoutStore.getState().byWorkspace[id] : undefined
  if (!layout) return []
  const active = findPane(layout.root, layout.activePaneId)
  const touched = usePaneRecencyStore.getState().touchedAt
  const rank = (paneId: string): number =>
    paneId === active?.id ? Number.POSITIVE_INFINITY : (touched[paneId] ?? 0)
  return allPanes(layout.root)
    .filter((p) => p.kind === 'terminal' && !p.hibernated)
    .sort((a, b) => rank(b.id) - rank(a.id))
    .map((p) => ({ paneId: p.id, title: p.title, idle: isIdlePrompt(blocks, p.id) }))
}

export function insertInto(paneId: string, text: string): boolean {
  const command = text.replace(/\s+$/, '')
  return canTypeInto(paneId) && insertCommand(paneId, command)
}

export function runInNewTerminal(
  workspaceId: string | null | undefined,
  text: string,
): string | null {
  const id = targetWorkspace(workspaceId)
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === id)
  const command = text.replace(/\s+$/, '')
  if (!id || !workspace || !command) return null
  const layouts = useLayoutStore.getState()
  const beside = workspaceTerminals(id, useBlocksStore.getState())[0]?.paneId
  const paneId = beside
    ? layouts.newTab(id, beside, 'terminal')
    : layouts.openTerminal(id, { cwd: workspace.workDir })
  if (!paneId) return null
  if (beside) layouts.setCwd(id, paneId, workspace.workDir)
  runWhenIdle(paneId, command)
  return paneId
}

export const runConfirmed = new Set<string>()

export function sendToAgent(target: ReferenceTarget, text: string): Promise<boolean> {
  return sendReference(target, text)
}

const FILE_EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'zsh',
  fish: 'fish',
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  rust: 'rs',
  rs: 'rs',
  go: 'go',
  html: 'html',
  css: 'css',
  sql: 'sql',
  markdown: 'md',
  md: 'md',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  ruby: 'rb',
  rb: 'rb',
  lua: 'lua',
  ini: 'ini',
  xml: 'xml',
}

export function suggestedFileName(language: string): string {
  const lang = language.toLowerCase()
  if (lang === 'dockerfile') return 'Dockerfile'
  if (lang === 'makefile' || lang === 'make') return 'Makefile'
  return `snippet.${FILE_EXTENSIONS[lang] ?? 'txt'}`
}

export type SaveOutcome = 'saved' | 'cancelled' | 'failed'

export async function saveCodeAsFile(code: string, language: string): Promise<SaveOutcome> {
  const res = await window.ostia.chatSessions
    .saveFile(suggestedFileName(language), code.endsWith('\n') ? code : `${code}\n`)
    .catch(() => null)
  if (!res) return 'failed'
  if (!res.ok) return res.error === 'cancelled' ? 'cancelled' : 'failed'
  openFileInWorkspace(res.path)
  return 'saved'
}

const COMMAND_WORD = /^[a-z][a-z0-9._+-]*$/

export function looksLikeCommand(text: string): boolean {
  const line = text.trim()
  if (!line || line.length > 200 || line.includes('\n') || line.includes('`')) return false
  const [first, ...rest] = line.split(/\s+/)
  return rest.length > 0 && COMMAND_WORD.test(first)
}

export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length
}

export function formatSize(bytes: number, locale?: string): string {
  if (bytes < 1024) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'byte',
      unitDisplay: 'narrow',
    }).format(bytes)
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'kilobyte',
    unitDisplay: 'narrow',
    maximumFractionDigits: 1,
  }).format(bytes / 1024)
}

export function idleTerminals(workspaceId: string | null | undefined): TerminalTarget[] {
  return workspaceTerminals(workspaceId, useBlocksStore.getState()).filter((t) => t.idle)
}
