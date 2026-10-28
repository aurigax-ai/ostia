import { Chat } from '@ai-sdk/react'
import type {
  AgentHistoryEntry,
  AgentModelRef,
  AgentReply,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { create } from 'zustand'
import { agentCoreToolDefs } from '@/lib/agent/agentCoreTools'
import { agentProblem } from '@/lib/agent/agentProblem'
import { createAgentTransport } from '@/lib/agent/agentTransport'
import type { ChatToolDef } from '@/lib/assist/chatToolGate'
import { initialMode, type PaneRole } from '@/lib/assist/chatToolPermissions'
import { chatToolDefs, workspaceFolder } from '@/lib/assist/chatTools'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import { useChatToolsStore } from '@/stores/assist/chatToolsStore'

interface AgentRules {
  on: boolean
  count: number
}

interface AgentStoreState {
  current: Record<string, string>
  models: Record<string, AgentModelRef>
  rules: Record<string, AgentRules>
  setCurrent: (workspaceId: string, sessionId: string) => void
  setModel: (sessionId: string, model: AgentModelRef) => void
  setRules: (sessionId: string, rules: Partial<AgentRules>) => void
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  current: {},
  models: {},
  rules: {},
  setRules: (sessionId, rules) =>
    set((s) => ({
      rules: {
        ...s.rules,
        [sessionId]: { ...(s.rules[sessionId] ?? { on: true, count: 0 }), ...rules },
      },
    })),
  setCurrent: (workspaceId, sessionId) =>
    set((s) => ({ current: { ...s.current, [workspaceId]: sessionId } })),
  setModel: (sessionId, model) => set((s) => ({ models: { ...s.models, [sessionId]: model } })),
}))

interface Opened {
  workspaceId: string
  paneId: string
  specsKey: string
  model: string
  rules: boolean
}

const chats = new Map<string, Chat<OstiaChatMessage>>()
const opened = new Map<string, Opened>()
const workspaceOf = new Map<string, string>()
const paneOf = new Map<string, string>()

function agentToolDefs(sessionId: string): ChatToolDef[] {
  return [...chatToolDefs(sessionId), ...agentCoreToolDefs()]
}

export function agentAttachmentKey(workspaceId: string | null | undefined): string {
  return `agent:${workspaceId ?? ''}`
}

function newSessionId(): string {
  return `a${crypto.randomUUID().replaceAll('-', '')}`
}

function modelKey(model: AgentModelRef | undefined): string {
  return model ? `${model.provider}/${model.model}` : ''
}

async function openSession(sessionId: string): Promise<AgentReply> {
  const workspaceId = workspaceOf.get(sessionId)
  const paneId = paneOf.get(sessionId)
  if (!workspaceId || !paneId) return { ok: false, error: 'unknown-workspace' }
  const specs = agentToolDefs(sessionId).map((def) => def.spec)
  const model = useAgentStore.getState().models[sessionId]
  const rules = useAgentStore.getState().rules[sessionId]?.on ?? true
  const next: Opened = {
    workspaceId,
    paneId,
    specsKey: JSON.stringify(specs),
    model: modelKey(model),
    rules,
  }
  const known = opened.get(sessionId)
  if (
    known &&
    known.workspaceId === next.workspaceId &&
    known.paneId === next.paneId &&
    known.specsKey === next.specsKey &&
    known.model === next.model &&
    known.rules === next.rules
  ) {
    return { ok: true }
  }
  const reply = await window.ostia.agentSessions.open(sessionId, {
    workspaceId,
    paneId,
    cwd: workspaceFolder(workspaceId),
    tools: specs,
    rules,
    ...(model ? { model } : {}),
  })
  if (reply.ok) {
    opened.set(sessionId, next)
    useAgentStore.getState().setRules(sessionId, { count: reply.rules ?? 0 })
    if (reply.model && !model) useAgentStore.getState().setModel(sessionId, reply.model)
  }
  return reply
}

async function prepare(sessionId: string): Promise<string | null> {
  const reply = await openSession(sessionId)
  return reply.ok ? null : agentProblem(reply)
}

function historyMessages(history: AgentHistoryEntry[] | undefined): OstiaChatMessage[] {
  return (history ?? []).map((entry, index) => ({
    id: `h${index}`,
    role: entry.role,
    parts: [{ type: 'text', text: entry.text }],
  }))
}

function createChat(sessionId: string, messages: OstiaChatMessage[]): Chat<OstiaChatMessage> {
  const chat = new Chat<OstiaChatMessage>({
    id: sessionId,
    messages,
    transport: createAgentTransport({
      sessionId,
      workspaceId: () => workspaceOf.get(sessionId) ?? null,
      root: () => workspaceFolder(workspaceOf.get(sessionId) ?? null),
      tools: () => agentToolDefs(sessionId),
      prepare: () => prepare(sessionId),
    }),
  })
  chats.set(sessionId, chat)
  return chat
}

export function agentChatFor(sessionId: string): Chat<OstiaChatMessage> {
  return chats.get(sessionId) ?? createChat(sessionId, [])
}

export function wirePortalPrompts(): void {
  window.ostia.agentSessions.onPrompted(({ sessionId, text }) => {
    void agentChatFor(sessionId).sendMessage({ text, metadata: { createdAt: Date.now() } })
  })
}

export async function setAgentRules(sessionId: string, on: boolean): Promise<AgentReply> {
  useAgentStore.getState().setRules(sessionId, { on })
  return openSession(sessionId)
}

export async function ensureAgentSession(
  workspaceId: string,
  paneId: string,
  preferred?: string,
  role: PaneRole = 'agent',
): Promise<string> {
  const id = preferred ?? useAgentStore.getState().current[workspaceId] ?? newSessionId()
  if (useChatToolsStore.getState().mode[id] === undefined) {
    useChatToolsStore.getState().setMode(id, initialMode(role))
  }
  const moved =
    (paneOf.has(id) && paneOf.get(id) !== paneId) ||
    (workspaceOf.has(id) && workspaceOf.get(id) !== workspaceId)
  workspaceOf.set(id, workspaceId)
  paneOf.set(id, paneId)
  if (!chats.has(id)) {
    const reply = await openSession(id)
    createChat(id, reply.ok ? historyMessages(reply.history) : [])
  } else if (moved) {
    await openSession(id)
  }
  useAgentStore.getState().setCurrent(workspaceId, id)
  return id
}

export function startNewAgentSession(workspaceId: string, paneId: string): Promise<string> {
  return ensureAgentSession(workspaceId, paneId, newSessionId())
}
