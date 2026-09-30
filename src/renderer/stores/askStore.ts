import {
  type AssistError,
  CHAT_CONTEXT_MAX,
  type ChatContextItem,
  type ChatMessage,
} from '@shared/assist'
import { create } from 'zustand'
import { assistRequest } from './assistStore'

export type AskTurnStatus = 'streaming' | 'done' | 'stopped' | 'error'

export interface AskUserTurn {
  id: string
  role: 'user'
  content: string
  context: ChatContextItem[]
}

export interface AskAnswerTurn {
  id: string
  role: 'assistant'
  content: string
  status: AskTurnStatus
  error?: { code: AssistError; message?: string }
}

export type AskTurn = AskUserTurn | AskAnswerTurn

interface AskState {
  byWorkspace: Record<string, AskTurn[]>
  send: (key: string, text: string, context: ChatContextItem[]) => Promise<void>
  regenerate: (key: string) => Promise<void>
  stop: (key: string) => void
  stopAll: () => void
  clear: (key: string) => void
}

const controllers = new Map<string, AbortController>()
let turnSeq = 0

function nextTurnId(): string {
  turnSeq += 1
  return `t${turnSeq}`
}

export function askKey(workspaceId: string | null): string {
  return workspaceId ?? ''
}

export function isStreaming(turns: readonly AskTurn[] | undefined): boolean {
  const last = turns?.[turns.length - 1]
  return last?.role === 'assistant' && last.status === 'streaming'
}

export function chatMessages(turns: readonly AskTurn[]): ChatMessage[] {
  return turns
    .filter((t) => t.role === 'user' || (t.status !== 'error' && t.content.trim() !== ''))
    .map((t) => ({ role: t.role, content: t.content }))
}

export function chatContext(turns: readonly AskTurn[]): ChatContextItem[] {
  const out: ChatContextItem[] = []
  for (const turn of [...turns].reverse()) {
    if (turn.role !== 'user') continue
    for (const item of turn.context) {
      if (out.length >= CHAT_CONTEXT_MAX) return out
      if (!out.some((o) => o.kind === item.kind && o.label === item.label)) out.push(item)
    }
  }
  return out
}

export const useAskStore = create<AskState>((set, get) => {
  const patchAnswer = (key: string, id: string, patch: (t: AskAnswerTurn) => AskAnswerTurn) =>
    set((s) => {
      const turns = s.byWorkspace[key]
      if (!turns) return s
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [key]: turns.map((t) => (t.id === id && t.role === 'assistant' ? patch(t) : t)),
        },
      }
    })

  const answer = async (key: string): Promise<void> => {
    const history = get().byWorkspace[key] ?? []
    const messages = chatMessages(history)
    const context = chatContext(history)
    const id = nextTurnId()
    controllers.get(key)?.abort()
    const controller = new AbortController()
    controllers.set(key, controller)
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [key]: [...history, { id, role: 'assistant', content: '', status: 'streaming' }],
      },
    }))
    const res = await assistRequest(
      'chat',
      { messages, context },
      {
        signal: controller.signal,
        onChunk: (text) => patchAnswer(key, id, (t) => ({ ...t, content: t.content + text })),
      },
    )
    if (controllers.get(key) === controller) controllers.delete(key)
    if (res.ok) {
      patchAnswer(key, id, (t) => ({ ...t, content: res.result.text || t.content, status: 'done' }))
    } else if (res.error === 'cancelled') {
      patchAnswer(key, id, (t) => ({ ...t, status: 'stopped' }))
    } else {
      patchAnswer(key, id, (t) => ({
        ...t,
        status: 'error',
        error: { code: res.error, message: res.message },
      }))
    }
  }

  return {
    byWorkspace: {},

    send: async (key, text, context) => {
      const content = text.trim()
      if (!content || isStreaming(get().byWorkspace[key])) return
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [key]: [
            ...(s.byWorkspace[key] ?? []),
            { id: nextTurnId(), role: 'user', content, context },
          ],
        },
      }))
      await answer(key)
    },

    regenerate: async (key) => {
      const turns = get().byWorkspace[key] ?? []
      const last = turns[turns.length - 1]
      if (last?.role !== 'assistant' || last.status === 'streaming') return
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [key]: turns.slice(0, -1) } }))
      await answer(key)
    },

    stop: (key) => controllers.get(key)?.abort(),

    stopAll: () => {
      for (const controller of controllers.values()) controller.abort()
    },

    clear: (key) => {
      controllers.get(key)?.abort()
      set((s) => {
        const { [key]: _gone, ...rest } = s.byWorkspace
        return { byWorkspace: rest }
      })
    },
  }
})
