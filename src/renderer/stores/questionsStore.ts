import { isPaneViewed, signalPane } from '@/lib/attention/workspaceActivity'
import { wantsDesktopBanner } from '@shared/notificationSettings'
import type { QuestionReply, QuestionRequest, QuestionState } from '@shared/questions'
import { create } from 'zustand'
import { currentDict } from '../i18n/useDict'
import { useAttentionStore } from './attentionStore'
import { useSettingsStore } from './settingsStore'

export const SENT_LINGER_MS = 1600

export interface QuestionDraft {
  choices: number[]
  text: string
}

export const EMPTY_DRAFT: QuestionDraft = { choices: [], text: '' }

interface QuestionsState {
  pending: QuestionRequest[]
  sent: QuestionRequest[]
  drafts: Record<string, QuestionDraft>
  focusId: string | null
  apply: (state: QuestionState) => void
  setDraft: (id: string, draft: QuestionDraft) => void
  answer: (id: string, reply: QuestionReply) => Promise<boolean>
  dismiss: (id: string) => Promise<boolean>
  requestFocus: (id: string | null) => void
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _dropped, ...rest } = record
  return rest
}

export const useQuestionsStore = create<QuestionsState>((set, get) => ({
  pending: [],
  sent: [],
  drafts: {},
  focusId: null,
  apply: (state) =>
    set((s) => {
      const live = new Set(state.pending.map((q) => q.id))
      const drafts: Record<string, QuestionDraft> = {}
      for (const [id, draft] of Object.entries(s.drafts)) if (live.has(id)) drafts[id] = draft
      return { pending: state.pending, drafts }
    }),
  setDraft: (id, draft) => set((s) => ({ drafts: { ...s.drafts, [id]: draft } })),
  answer: async (id, reply) => {
    const request = get().pending.find((q) => q.id === id)
    if (request) set((s) => ({ sent: [...s.sent, request] }))
    const forgetSent = (): void => set((s) => ({ sent: s.sent.filter((q) => q.id !== id) }))
    const accepted = await window.ostia.questions.answer(id, reply)
    if (!accepted) {
      forgetSent()
      return false
    }
    set((s) => ({ drafts: without(s.drafts, id) }))
    setTimeout(forgetSent, SENT_LINGER_MS)
    return true
  },
  dismiss: (id) => window.ostia.questions.dismiss(id),
  requestFocus: (focusId) => set({ focusId }),
}))

export function addedQuestions(
  before: readonly QuestionRequest[],
  after: readonly QuestionRequest[],
): QuestionRequest[] {
  const known = new Set(before.map((q) => q.id))
  return after.filter((q) => !known.has(q.id))
}

function settle(question: QuestionRequest, remaining: readonly QuestionRequest[]): void {
  const attention = useAttentionStore.getState()
  const current = attention.byPane[question.paneId]
  if (current?.state !== 'waiting' || current.message !== question.question) return
  const next = remaining.find((q) => q.paneId === question.paneId)
  if (next) {
    signalPane(question.paneId, {
      type: 'set',
      state: 'waiting',
      message: next.question,
      at: Date.now(),
    })
    return
  }
  attention.dispatch(question.paneId, { type: 'waitEnded', at: Date.now() })
}

function announce(question: QuestionRequest): void {
  signalPane(question.paneId, {
    type: 'set',
    state: 'waiting',
    message: question.question,
    at: Date.now(),
  })
  window.ostia.notifications.post({
    paneId: question.paneId,
    kind: 'waiting',
    title: currentDict().dashboard.questionNotice,
    body: question.question,
    desktop: wantsDesktopBanner(
      useSettingsStore.getState().notifications,
      'agentWaiting',
      isPaneViewed(question.paneId) && document.hasFocus(),
    ),
  })
}

export function startQuestions(): () => void {
  const receive = (state: QuestionState): void => {
    const before = useQuestionsStore.getState().pending
    const added = addedQuestions(before, state.pending)
    const gone = addedQuestions(state.pending, before)
    useQuestionsStore.getState().apply(state)
    for (const question of gone) settle(question, state.pending)
    for (const question of added) announce(question)
  }
  const off = window.ostia.questions.onChange(receive)
  void window.ostia.questions.state().then(receive)
  return off
}
