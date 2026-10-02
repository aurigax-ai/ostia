import { Chat } from '@ai-sdk/react'
import { type AssistModelRef, CHAT_CONTEXT_MAX, type ChatContextItem } from '@shared/assist'
import {
  CHAT_EDIT_TEXT_MAX,
  CHAT_TITLE_MAX,
  type ChatSession,
  type ChatSessionEdit,
  type ChatSessionMessage,
  type ChatSessionSummary,
  chatTitle,
} from '@shared/chatSessions'
import { create } from 'zustand'
import { workspaceFolder } from '../lib/chatTools'
import { type PineChatMessage, createAssistTransport, messageText } from '../lib/chatTransport'
import { type ChatEditRecord, sessionEdits, useChatToolsStore } from './chatToolsStore'
import { useSettingsStore } from './settingsStore'
import { useWorkspacesStore } from './workspacesStore'

export type ChatNotice = 'trimmed' | 'evicted' | 'saveFailed'

export interface ChatSessionMeta {
  id: string
  workspaceId?: string
  title: string
  createdAt: number
  model?: string
  modelRef?: AssistModelRef
  trimmed?: boolean
  scratch?: boolean
}

interface ChatStoreState {
  current: Record<string, string>
  meta: Record<string, ChatSessionMeta>
  summaries: ChatSessionSummary[]
  notice: Record<string, ChatNotice>
  drafts: Record<string, string>
  attachments: Record<string, ChatContextItem[]>
  attach: (key: string, item: ChatContextItem) => void
  detach: (key: string, index: number) => void
  clearAttachments: (key: string) => void
  setDraft: (key: string, text: string) => void
  takeDraft: (key: string) => string | undefined
  setCurrent: (key: string, sessionId: string) => void
  setMeta: (meta: ChatSessionMeta) => void
  setSummaries: (summaries: ChatSessionSummary[]) => void
  setNotice: (sessionId: string, notice: ChatNotice | null) => void
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  current: {},
  meta: {},
  summaries: [],
  notice: {},
  drafts: {},
  attachments: {},
  attach: (key, item) =>
    set((s) => {
      const kept = (s.attachments[key] ?? []).filter(
        (a) => a.kind !== item.kind || a.label !== item.label,
      )
      return {
        attachments: { ...s.attachments, [key]: [...kept, item].slice(-CHAT_CONTEXT_MAX) },
      }
    }),
  detach: (key, index) =>
    set((s) => ({
      attachments: {
        ...s.attachments,
        [key]: (s.attachments[key] ?? []).filter((_, i) => i !== index),
      },
    })),
  clearAttachments: (key) =>
    set((s) => {
      const { [key]: _gone, ...rest } = s.attachments
      return { attachments: rest }
    }),
  setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
  takeDraft: (key) => {
    const text = get().drafts[key]
    if (text !== undefined) {
      set((s) => {
        const { [key]: _taken, ...rest } = s.drafts
        return { drafts: rest }
      })
    }
    return text
  },
  setCurrent: (key, sessionId) => set((s) => ({ current: { ...s.current, [key]: sessionId } })),
  setMeta: (meta) => set((s) => ({ meta: { ...s.meta, [meta.id]: meta } })),
  setSummaries: (summaries) => set({ summaries }),
  setNotice: (sessionId, notice) =>
    set((s) => {
      const next = { ...s.notice }
      if (notice) next[sessionId] = notice
      else delete next[sessionId]
      return { notice: next }
    }),
}))

const chats = new Map<string, Chat<PineChatMessage>>()
const loading = new Map<string, Promise<string>>()
let sessionSeq = 0

export const TITLE_FROM_QUESTION = 60

export function chatKey(workspaceId: string | null | undefined): string {
  return workspaceId ?? ''
}

export function newSessionId(): string {
  sessionSeq += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `c${Date.now().toString(36)}${sessionSeq.toString(36)}${random}`
}

export function titleFromMessages(messages: readonly PineChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  const text = first ? chatTitle(messageText(first)) : ''
  if (text.length <= TITLE_FROM_QUESTION) return text
  return `${text.slice(0, TITLE_FROM_QUESTION).trimEnd()}…`
}

function historyOn(): boolean {
  return useSettingsStore.getState().assistant.chatHistory
}

export function toSessionMessages(messages: readonly PineChatMessage[]): ChatSessionMessage[] {
  return messages.map((m) => {
    const out: ChatSessionMessage = { id: m.id, role: m.role, parts: m.parts as never }
    if (m.metadata) out.metadata = m.metadata
    return out
  })
}

export function sessionOf(
  meta: ChatSessionMeta,
  messages: readonly PineChatMessage[],
): ChatSession {
  const now = Date.now()
  const model =
    [...messages].reverse().find((m) => m.metadata?.model)?.metadata?.model ?? meta.model
  const session: ChatSession = {
    id: meta.id,
    title: meta.title || titleFromMessages(messages) || 'Chat',
    createdAt: meta.createdAt,
    updatedAt: now,
    messageCount: messages.length,
    messages: toSessionMessages(messages),
  }
  if (meta.workspaceId) session.workspaceId = meta.workspaceId
  if (model) session.model = model
  if (meta.modelRef) session.modelRef = meta.modelRef
  const edits = sessionEdits(meta.id).map(storedEdit)
  if (edits.length > 0) session.edits = edits
  return session
}

function storedEdit(edit: ChatEditRecord): ChatSessionEdit {
  const { sessionId: _sessionId, undoError: _undoError, before, after, ...rest } = edit
  const keep =
    before !== undefined &&
    after !== undefined &&
    before.length <= CHAT_EDIT_TEXT_MAX &&
    after.length <= CHAT_EDIT_TEXT_MAX
  return keep ? { ...rest, before, after } : rest
}

export async function saveSession(sessionId: string): Promise<void> {
  const chat = chats.get(sessionId)
  const meta = useChatStore.getState().meta[sessionId]
  if (!chat || !meta || meta.scratch || !historyOn() || chat.messages.length === 0) return
  const session = sessionOf(meta, chat.messages)
  if (!meta.title) useChatStore.getState().setMeta({ ...meta, title: session.title })
  const res = await window.pine.chatSessions.save(session).catch(() => null)
  const store = useChatStore.getState()
  if (!res?.ok) {
    store.setNotice(sessionId, 'saveFailed')
    return
  }
  if (res.trimmedMessages > 0) {
    store.setMeta({ ...(store.meta[sessionId] ?? meta), trimmed: true })
    store.setNotice(sessionId, 'trimmed')
  } else if (res.evicted.length > 0) {
    store.setNotice(sessionId, 'evicted')
  }
  await refreshSessions()
}

export function isScratchWorkspace(workspaceId: string | null | undefined): boolean {
  return useWorkspacesStore
    .getState()
    .workspaces.some((w) => w.id === workspaceId && w.kind === 'scratch')
}

function sessionWorkspace(sessionId: string): string | null {
  return (
    useChatStore.getState().meta[sessionId]?.workspaceId ??
    useWorkspacesStore.getState().activeWorkspaceId
  )
}

function createChat(sessionId: string, messages: PineChatMessage[]): Chat<PineChatMessage> {
  const chat = new Chat<PineChatMessage>({
    id: sessionId,
    messages,
    transport: createAssistTransport({
      sessionId,
      workspaceId: () => sessionWorkspace(sessionId),
      root: () => workspaceFolder(sessionWorkspace(sessionId)),
      model: () => useChatStore.getState().meta[sessionId]?.modelRef ?? null,
    }),
    onFinish: () => void saveSession(sessionId),
  })
  chats.set(sessionId, chat)
  return chat
}

export function chatFor(sessionId: string): Chat<PineChatMessage> {
  return chats.get(sessionId) ?? createChat(sessionId, [])
}

function moveKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in record)) return record
  const { [from]: moved, ...rest } = record
  return to in rest ? rest : { ...rest, [to]: moved }
}

export function chatReplacedByMerge(sourceId: string, targetId: string): boolean {
  const { current } = useChatStore.getState()
  return Boolean(current[chatKey(sourceId)] && current[chatKey(targetId)])
}

export function mergeChatWorkspace(sourceId: string, targetId: string): void {
  const from = chatKey(sourceId)
  const to = chatKey(targetId)
  useChatStore.setState((s) => {
    const meta: Record<string, ChatSessionMeta> = {}
    for (const [id, m] of Object.entries(s.meta)) {
      meta[id] = m.workspaceId === sourceId ? { ...m, workspaceId: targetId } : m
    }
    return {
      current: moveKey(s.current, from, to),
      drafts: moveKey(s.drafts, from, to),
      attachments: moveKey(s.attachments, from, to),
      meta,
    }
  })
}

export function currentSessionId(workspaceId: string | null | undefined): string | null {
  return useChatStore.getState().current[chatKey(workspaceId)] ?? null
}

export function startNewSession(workspaceId: string | null | undefined): string {
  const id = newSessionId()
  const meta: ChatSessionMeta = { id, title: '', createdAt: Date.now() }
  if (workspaceId) meta.workspaceId = workspaceId
  if (isScratchWorkspace(workspaceId)) meta.scratch = true
  const store = useChatStore.getState()
  store.setMeta(meta)
  createChat(id, [])
  store.setCurrent(chatKey(workspaceId), id)
  return id
}

function fromStored(session: ChatSession): PineChatMessage[] {
  return session.messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts as PineChatMessage['parts'],
    ...(m.metadata ? { metadata: m.metadata } : {}),
  }))
}

export async function openSession(
  workspaceId: string | null | undefined,
  sessionId: string,
): Promise<boolean> {
  const store = useChatStore.getState()
  if (!chats.has(sessionId)) {
    const session = await window.pine.chatSessions.get(sessionId).catch(() => null)
    if (!session) return false
    const meta: ChatSessionMeta = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
    }
    if (session.workspaceId) meta.workspaceId = session.workspaceId
    if (session.model) meta.model = session.model
    if (session.modelRef) meta.modelRef = session.modelRef
    if (session.trimmed) meta.trimmed = true
    store.setMeta(meta)
    useChatToolsStore.getState().loadEdits(session.id, session.edits ?? [])
    createChat(session.id, fromStored(session))
  }
  useChatStore.getState().setCurrent(chatKey(workspaceId), sessionId)
  return true
}

export async function refreshSessions(): Promise<ChatSessionSummary[]> {
  const list = await window.pine.chatSessions.list().catch(() => [] as ChatSessionSummary[])
  useChatStore.getState().setSummaries(list)
  return list
}

export function nameSession(sessionId: string, question: string): void {
  const store = useChatStore.getState()
  const meta = store.meta[sessionId]
  if (!meta || meta.title) return
  const text = chatTitle(question)
  const title =
    text.length <= TITLE_FROM_QUESTION ? text : `${text.slice(0, TITLE_FROM_QUESTION).trimEnd()}…`
  if (title) store.setMeta({ ...meta, title })
}

export function setSessionModel(sessionId: string, modelRef: AssistModelRef): void {
  const store = useChatStore.getState()
  const meta = store.meta[sessionId]
  if (!meta) return
  store.setMeta({ ...meta, modelRef })
  void saveSession(sessionId)
}

export function ensureSession(
  workspaceId: string | null | undefined,
  preferred?: string,
): Promise<string> {
  const key = chatKey(workspaceId)
  const current = useChatStore.getState().current[key]
  if (current) return Promise.resolve(current)
  const pending = loading.get(key)
  if (pending) return pending
  const work = (async () => {
    if (preferred && (await openSession(workspaceId, preferred))) return preferred
    const list = historyOn() && !isScratchWorkspace(workspaceId) ? await refreshSessions() : []
    const last = list.find((s) => (s.workspaceId ?? '') === key)
    const already = useChatStore.getState().current[key]
    if (already) return already
    if (last && (await openSession(workspaceId, last.id))) return last.id
    return startNewSession(workspaceId)
  })()
  loading.set(key, work)
  void work.finally(() => loading.delete(key))
  return work
}

export async function renameSession(sessionId: string, title: string): Promise<boolean> {
  const next = chatTitle(title).slice(0, CHAT_TITLE_MAX)
  if (!next) return false
  const store = useChatStore.getState()
  const meta = store.meta[sessionId]
  if (meta) store.setMeta({ ...meta, title: next })
  const saved = await window.pine.chatSessions.rename(sessionId, next).catch(() => null)
  if (saved) await refreshSessions()
  return true
}

export async function clearSession(sessionId: string): Promise<void> {
  const chat = chats.get(sessionId)
  if (chat) chat.messages = []
  const store = useChatStore.getState()
  const meta = store.meta[sessionId]
  if (meta) {
    const { trimmed: _trimmed, ...kept } = meta
    store.setMeta({ ...kept, title: '' })
  }
  store.setNotice(sessionId, null)
  await window.pine.chatSessions.remove(sessionId).catch(() => false)
  await refreshSessions()
}

export async function deleteSession(sessionId: string): Promise<void> {
  chats.get(sessionId)?.stop()
  chats.delete(sessionId)
  await window.pine.chatSessions.remove(sessionId).catch(() => false)
  const store = useChatStore.getState()
  for (const [key, id] of Object.entries(store.current)) {
    if (id === sessionId) startNewSession(key || null)
  }
  store.setNotice(sessionId, null)
  await refreshSessions()
}

export function stopAllChats(): void {
  for (const chat of chats.values()) {
    if (chat.status === 'streaming' || chat.status === 'submitted') void chat.stop()
  }
}

export function resetChats(): void {
  for (const chat of chats.values()) void chat.stop()
  chats.clear()
  loading.clear()
  sessionSeq = 0
}
