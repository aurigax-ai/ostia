import type { HunkDecision } from '@/lib/assist/chatHunks'
import {
  type ApprovalAnswer,
  type ApprovalKind,
  type ChatMode,
  DEFAULT_CHAT_MODE,
  type ToolDecision,
  type WriteAskReason,
  alwaysGrantAfter,
  grantsAfter,
} from '@/lib/assist/chatToolPermissions'
import type { ChatSessionEdit } from '@shared/chatSessions'
import type { ChatFsError, McpServerStatus, SkillSummary } from '@shared/chatTools'
import { create } from 'zustand'

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

export interface ChatEditRecord extends ChatSessionEdit {
  sessionId: string
  undoError?: ChatFsError
}

interface ChatToolsState {
  pending: Record<string, PendingApproval>
  grants: Record<string, string[]>
  standing: string[]
  off: Record<string, string[]>
  mode: Record<string, ChatMode>
  edits: Record<string, ChatEditRecord>
  hunkChoices: Record<string, (HunkDecision | null)[]>
  failures: Record<string, ChatFsError>
  versions: Record<string, Record<string, string>>
  mcp: McpServerStatus[]
  skills: SkillSummary[]
  setMcp: (mcp: McpServerStatus[]) => void
  setSkills: (skills: SkillSummary[]) => void
  toggle: (sessionId: string, key: string, on: boolean) => void
  setMode: (sessionId: string, mode: ChatMode) => void
  recordEdit: (edit: ChatEditRecord) => void
  loadEdits: (sessionId: string, edits: readonly ChatSessionEdit[]) => void
  chooseHunk: (toolCallId: string, index: number, decision: HunkDecision | null) => void
  clearHunks: (toolCallId: string) => void
  recordFailure: (toolCallId: string, error: ChatFsError) => void
  setVersion: (sessionId: string, path: string, version: string | null) => void
}

const resolvers = new Map<string, (answer: ApprovalAnswer) => void>()

export const useChatToolsStore = create<ChatToolsState>((set) => ({
  pending: {},
  grants: {},
  standing: [],
  off: {},
  mode: {},
  edits: {},
  hunkChoices: {},
  failures: {},
  versions: {},
  mcp: [],
  skills: [],
  setMode: (sessionId, mode) => set((s) => ({ mode: { ...s.mode, [sessionId]: mode } })),
  recordEdit: (edit) => set((s) => ({ edits: { ...s.edits, [edit.toolCallId]: edit } })),
  loadEdits: (sessionId, edits) =>
    set((s) => {
      const next = { ...s.edits }
      for (const edit of edits) next[edit.toolCallId] = { ...edit, sessionId }
      return { edits: next }
    }),
  chooseHunk: (toolCallId, index, decision) =>
    set((s) => {
      const choices = [...(s.hunkChoices[toolCallId] ?? [])]
      choices[index] = decision
      return { hunkChoices: { ...s.hunkChoices, [toolCallId]: choices } }
    }),
  clearHunks: (toolCallId) =>
    set((s) => {
      const { [toolCallId]: _gone, ...rest } = s.hunkChoices
      return { hunkChoices: rest }
    }),
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

export function standingGrants(): ReadonlySet<string> {
  return new Set(useChatToolsStore.getState().standing)
}

function setStanding(keys: string[]): void {
  useChatToolsStore.setState({ standing: keys })
}

function grantAlways(key: string): void {
  void window.ostia.chatTools.grantAlways(key).then(setStanding)
}

export async function removeAlwaysGrant(key: string): Promise<void> {
  setStanding(await window.ostia.chatTools.removeAlwaysGrant(key))
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

export function sessionEdits(sessionId: string): ChatEditRecord[] {
  return Object.values(useChatToolsStore.getState().edits)
    .filter((e) => e.sessionId === sessionId)
    .sort((a, b) => a.seq - b.seq)
}

export function nextSeq(sessionId: string): number {
  return sessionEdits(sessionId).reduce((max, e) => Math.max(max, e.seq), 0) + 1
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
      const standingKey = alwaysGrantAfter(decision, answer)
      if (standingKey) grantAlways(standingKey)
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
  const skills = await window.ostia.chatTools.skills().catch(() => [] as SkillSummary[])
  useChatToolsStore.getState().setSkills(skills)
  return skills
}

export async function refreshMcp(): Promise<McpServerStatus[]> {
  const mcp = await window.ostia.chatTools.mcpRefresh().catch(() => [] as McpServerStatus[])
  useChatToolsStore.getState().setMcp(mcp)
  return mcp
}

export function startChatTools(): () => void {
  const off =
    window.ostia?.chatTools?.onMcpStatus?.((mcp) => useChatToolsStore.getState().setMcp(mcp)) ??
    (() => {})
  const offStanding = window.ostia?.chatTools?.onAlwaysGrants?.(setStanding) ?? (() => {})
  void window.ostia?.chatTools
    ?.mcpStatus?.()
    .then((mcp) => useChatToolsStore.getState().setMcp(mcp))
    .catch(() => {})
  void window.ostia?.chatTools
    ?.alwaysGrants?.()
    .then(setStanding)
    .catch(() => {})
  return () => {
    off()
    offStanding()
  }
}

export function resetChatTools(): void {
  resolvers.clear()
  useChatToolsStore.setState({
    pending: {},
    grants: {},
    standing: [],
    off: {},
    mode: {},
    edits: {},
    hunkChoices: {},
    failures: {},
    versions: {},
    mcp: [],
    skills: [],
  })
}
