import { useSettingsStore } from '@/stores/app/settingsStore'
import type { QuestionRequest, QuestionState } from '@shared/agents/questions'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from './attentionStore'
import { SENT_LINGER_MS, addedQuestions, startQuestions, useQuestionsStore } from './questionsStore'

function question(id: string, paneId: string, text: string, at = 1): QuestionRequest {
  return { id, paneId, question: text, context: '', choices: [], mode: 'text', at }
}

describe('questionsStore', () => {
  let questionsInit: ReturnType<typeof useQuestionsStore.getState>
  let attentionInit: ReturnType<typeof useAttentionStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let receive: (state: QuestionState) => void
  let stop: () => void

  beforeAll(() => {
    questionsInit = useQuestionsStore.getState()
    attentionInit = useAttentionStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.questions.onChange).mockImplementation((cb) => {
      receive = cb
      return () => {}
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    stop = startQuestions()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    useQuestionsStore.setState(questionsInit, true)
    useAttentionStore.setState(attentionInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  const attention = (paneId: string) => useAttentionStore.getState().byPane[paneId]

  it('marks the asking pane waiting with the question as its message', () => {
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    expect(attention('p1')).toMatchObject({
      state: 'waiting',
      unread: true,
      message: 'Which database?',
    })
    expect(useQuestionsStore.getState().pending).toHaveLength(1)
  })

  it('posts a notification for a new question, with a desktop banner while the window is away', () => {
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    expect(window.ostia.notifications.post).toHaveBeenCalledTimes(1)
    expect(window.ostia.notifications.post).toHaveBeenCalledWith({
      paneId: 'p1',
      kind: 'waiting',
      title: 'Agent asks',
      body: 'Which database?',
      desktop: true,
    })
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    expect(window.ostia.notifications.post).toHaveBeenCalledTimes(1)
  })

  it('raises no desktop banner when the human turned agent-waiting banners off', () => {
    const settings = useSettingsStore.getState()
    useSettingsStore.setState({
      notifications: { ...settings.notifications, agentWaiting: false },
    })
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    expect(window.ostia.notifications.post).toHaveBeenCalledWith(
      expect.objectContaining({ desktop: false }),
    )
  })

  it('ends the waiting state when the question is answered, dismissed or timed out', () => {
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    receive({ pending: [] })
    expect(attention('p1')?.state).toBe('none')
  })

  it('leaves a waiting state that is no longer about the question', () => {
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    useAttentionStore
      .getState()
      .dispatch('p1', { type: 'set', state: 'waiting', message: 'Approve the plan', at: 5 })
    receive({ pending: [] })
    expect(attention('p1')).toMatchObject({ state: 'waiting', message: 'Approve the plan' })
  })

  it('keeps the pane waiting on its next open question', () => {
    const first = question('q1', 'p1', 'First?', 1)
    const second = question('q2', 'p1', 'Second?', 2)
    receive({ pending: [first] })
    receive({ pending: [first, second] })
    expect(attention('p1')?.message).toBe('Second?')
    receive({ pending: [first] })
    expect(attention('p1')).toMatchObject({ state: 'waiting', message: 'First?' })
  })

  it('sends the reply to main and shows the question as sent for a moment', async () => {
    vi.useFakeTimers()
    const q = question('q1', 'p1', 'Which database?')
    receive({ pending: [q] })
    useQuestionsStore.getState().setDraft('q1', { choices: [], text: 'staging' })
    const accepted = await useQuestionsStore
      .getState()
      .answer('q1', { choices: [], text: 'staging' })
    expect(accepted).toBe(true)
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('q1', {
      choices: [],
      text: 'staging',
    })
    expect(useQuestionsStore.getState().sent).toEqual([q])
    expect(useQuestionsStore.getState().drafts).toEqual({})
    vi.advanceTimersByTime(SENT_LINGER_MS)
    expect(useQuestionsStore.getState().sent).toEqual([])
  })

  it('keeps the question and its draft when main refuses the reply', async () => {
    vi.mocked(window.ostia.questions.answer).mockResolvedValue(false)
    receive({ pending: [question('q1', 'p1', 'Which database?')] })
    useQuestionsStore.getState().setDraft('q1', { choices: [], text: 'x' })
    expect(await useQuestionsStore.getState().answer('q1', { choices: [], text: 'x' })).toBe(false)
    expect(useQuestionsStore.getState().sent).toEqual([])
    expect(useQuestionsStore.getState().drafts.q1).toEqual({ choices: [], text: 'x' })
  })

  it('drops the draft of a question that left and keeps the others', () => {
    const q1 = question('q1', 'p1', 'One?')
    const q2 = question('q2', 'p2', 'Two?')
    receive({ pending: [q1, q2] })
    useQuestionsStore.getState().setDraft('q1', { choices: [], text: 'a' })
    useQuestionsStore.getState().setDraft('q2', { choices: [], text: 'b' })
    receive({ pending: [q2] })
    expect(useQuestionsStore.getState().drafts).toEqual({ q2: { choices: [], text: 'b' } })
  })

  it('dismisses through main', async () => {
    await useQuestionsStore.getState().dismiss('q1')
    expect(window.ostia.questions.dismiss).toHaveBeenCalledWith('q1')
  })
})

describe('addedQuestions', () => {
  it('returns only the questions that were not there before', () => {
    const a = question('a', 'p1', 'a')
    const b = question('b', 'p1', 'b')
    expect(addedQuestions([a], [a, b])).toEqual([b])
    expect(addedQuestions([a, b], [b])).toEqual([])
  })
})
