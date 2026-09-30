import type { McpServerStatus, SkillSummary } from '@shared/chatTools'
import { create } from 'zustand'
import {
  type ApprovalAnswer,
  type ApprovalKind,
  type ToolDecision,
  grantsAfter,
} from '../lib/chatToolPermissions'

export interface ApprovalDetail {
  path?: string
  exists?: boolean
  before?: string
  after?: string
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

interface ChatToolsState {
  pending: Record<string, PendingApproval>
  grants: Record<string, string[]>
  off: Record<string, string[]>
  mcp: McpServerStatus[]
  skills: SkillSummary[]
  setMcp: (mcp: McpServerStatus[]) => void
  setSkills: (skills: SkillSummary[]) => void
  toggle: (sessionId: string, key: string, on: boolean) => void
}

const resolvers = new Map<string, (answer: ApprovalAnswer) => void>()

export const useChatToolsStore = create<ChatToolsState>((set) => ({
  pending: {},
  grants: {},
  off: {},
  mcp: [],
  skills: [],
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
  useChatToolsStore.setState({ pending: {}, grants: {}, off: {}, mcp: [], skills: [] })
}
