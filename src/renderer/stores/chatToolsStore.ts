import type { ChatFsError, McpServerStatus, SkillSummary } from '@shared/chatTools'
import { create } from 'zustand'
import {
  type ApprovalAnswer,
  type ApprovalKind,
  type ChatMode,
  DEFAULT_CHAT_MODE,
  type ToolDecision,
  type WriteAskReason,
  grantsAfter,
} from '../lib/chatToolPermissions'

export interface ApprovalDetail {
  path?: string
  exists?: boolean
  before?: string
  after?: string
  reason?: WriteAskReason
  command?: string
  url?: string
  server?: string
  tool?: string
}

export interface PendingApproval {
  toolCallId: string
  sessionId: string
  toolName: string
  kind: ApprovalKind
  grantable: boolean
  input: Record<string, unknown>
  detail: ApprovalDetail
}

export type ChatEditState = 'applied' | 'undone'

export interface ChatEditRecord {
  toolCallId: string
  sessionId: string
  path: string
  root: string
  existed: boolean
  before: string
  after: string
  version: string
  outside: boolean
  symlink: boolean
  auto: boolean
  state: ChatEditState
  undoError?: ChatFsError
}

interface ChatToolsState {
  pending: Record<string, PendingApproval>
  grants: Record<string, string[]>
  off: Record<string, string[]>
  mode: Record<string, ChatMode>
  edits: Record<string, ChatEditRecord>
  failures: Record<string, ChatFsError>
  versions: Record<string, Record<string, string>>
  mcp: McpServerStatus[]
  skills: SkillSummary[]
  setMcp: (mcp: McpServerStatus[]) => void
  setSkills: (skills: SkillSummary[]) => void
  toggle: (sessionId: string, key: string, on: boolean) => void
  setMode: (sessionId: string, mode: ChatMode) => void
  recordEdit: (edit: ChatEditRecord) => void
  recordFailure: (toolCallId: string, error: ChatFsError) => void
  setVersion: (sessionId: string, path: string, version: string | null) => void
}

const resolvers = new Map<string, (answer: ApprovalAnswer) => void>()

export const useChatToolsStore = create<ChatToolsState>((set) => ({
  pending: {},
  grants: {},
  off: {},
  mode: {},
  edits: {},
  failures: {},
  versions: {},
  mcp: [],
  skills: [],
  setMode: (sessionId, mode) => set((s) => ({ mode: { ...s.mode, [sessionId]: mode } })),
  recordEdit: (edit) => set((s) => ({ edits: { ...s.edits, [edit.toolCallId]: edit } })),
  recordFailure: (toolCallId, error) =>
    set((s) => ({ failures: { ...s.failures, [toolCallId]: error } })),
  setVersion: (sessionId, path, version) =>
    set((s) => {
      const known = { ...(s.versions[sessionId] ?? {}) }
      if (version === null) delete known[path]
      else known[path] = version
      return { versions: { ...s.versions, [sessionId]: known } }
    }),
  setMcp: (mcp) => set({ mcp }),
  setSkills: (skills) => set({ skills }),
  toggle: (sessionId, key, on) =>
    set((s) => {
      const current = new Set(s.off[sessionId] ?? [])
      if (on) current.delete(key)
      else current.add(key)
      return { off: { ...s.off, [sessionId]: [...current] } }
    }),
}))

export function isToolOn(sessionId: string, key: string): boolean {
  return !(useChatToolsStore.getState().off[sessionId] ?? []).includes(key)
}

export function grantsFor(sessionId: string): ReadonlySet<string> {
  return new Set(useChatToolsStore.getState().grants[sessionId] ?? [])
}

export function modeFor(sessionId: string): ChatMode {
  return useChatToolsStore.getState().mode[sessionId] ?? DEFAULT_CHAT_MODE
}

export function useChatMode(sessionId: string): ChatMode {
  return useChatToolsStore((s) => s.mode[sessionId] ?? DEFAULT_CHAT_MODE)
}

export function knownVersion(sessionId: string, path: string): string | null {
  return useChatToolsStore.getState().versions[sessionId]?.[path] ?? null
}

const undoing = new Set<string>()

export async function undoEdit(toolCallId: string): Promise<void> {
  const edit = useChatToolsStore.getState().edits[toolCallId]
  if (!edit || edit.state !== 'applied' || undoing.has(toolCallId)) return
  undoing.add(toolCallId)
  try {
    await undoNow(edit)
  } finally {
    undoing.delete(toolCallId)
  }
}

async function undoNow(edit: ChatEditRecord): Promise<void> {
  const res = await window.pine.chatTools
    .undo({
      path: edit.path,
      root: edit.root,
      outside: edit.outside,
      symlinks: edit.symlink,
      wrote: edit.version,
      restore: edit.existed ? edit.before : null,
    })
    .catch(() => ({ ok: false as const, error: 'failed' as const }))
  const store = useChatToolsStore.getState()
  if (!res.ok) {
    store.recordEdit({ ...edit, undoError: res.error })
    return
  }
  const { undoError: _cleared, ...rest } = edit
  store.recordEdit({ ...rest, state: 'undone' })
  store.setVersion(edit.sessionId, edit.path, res.version)
}

function dropPending(toolCallId: string): void {
  resolvers.delete(toolCallId)
  useChatToolsStore.setState((s) => {
    const { [toolCallId]: _gone, ...rest } = s.pending
    return { pending: rest }
  })
}

export function requestApproval(
  request: PendingApproval,
  decision: ToolDecision,
  signal: AbortSignal,
): Promise<ApprovalAnswer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      dropPending(request.toolCallId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    resolvers.set(request.toolCallId, (answer) => {
      signal.removeEventListener('abort', onAbort)
      dropPending(request.toolCallId)
      useChatToolsStore.setState((s) => ({
        grants: {
          ...s.grants,
          [request.sessionId]: [
            ...grantsAfter(new Set(s.grants[request.sessionId] ?? []), decision, answer),
          ],
        },
      }))
      resolve(answer)
    })
    useChatToolsStore.setState((s) => ({
      pending: { ...s.pending, [request.toolCallId]: request },
    }))
  })
}

export function answerApproval(toolCallId: string, answer: ApprovalAnswer): void {
  resolvers.get(toolCallId)?.(answer)
}

export async function refreshSkills(): Promise<SkillSummary[]> {
  const skills = await window.pine.chatTools.skills().catch(() => [] as SkillSummary[])
  useChatToolsStore.getState().setSkills(skills)
  return skills
}

export async function refreshMcp(): Promise<McpServerStatus[]> {
  const mcp = await window.pine.chatTools.mcpRefresh().catch(() => [] as McpServerStatus[])
  useChatToolsStore.getState().setMcp(mcp)
  return mcp
}

export function startChatTools(): () => void {
  const off =
    window.pine?.chatTools?.onMcpStatus?.((mcp) => useChatToolsStore.getState().setMcp(mcp)) ??
    (() => {})
  void window.pine?.chatTools
    ?.mcpStatus?.()
    .then((mcp) => useChatToolsStore.getState().setMcp(mcp))
    .catch(() => {})
  return off
}

export function resetChatTools(): void {
  resolvers.clear()
  useChatToolsStore.setState({
    pending: {},
    grants: {},
    off: {},
    mode: {},
    edits: {},
    failures: {},
    versions: {},
    mcp: [],
    skills: [],
  })
}
