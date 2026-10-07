import { ChatCircleTextIcon } from '@phosphor-icons/react'
import type { QuestionRequest } from '@shared/questions'
import { useDict } from '../i18n/useDict'
import { useQuestionsStore } from '../stores/questionsStore'
import { useUIStore } from '../stores/uiStore'
import { questionTitle } from './QuestionCard'
import { Button } from './ui/button'

export function QuestionNotice({ question }: { question: QuestionRequest }): JSX.Element {
  const d = useDict()
  const answer = (): void => {
    useQuestionsStore.getState().requestFocus(question.id)
    useUIStore.getState().openDashboard()
  }
  return (
    <section
      aria-label={d.dashboard.questionNotice}
      className="motion-enter absolute right-2 bottom-2 left-2 z-20 flex origin-bottom items-center gap-2 rounded-md border border-line bg-surface-3 p-2 text-fg text-ui-sm shadow-md"
    >
      <ChatCircleTextIcon size={14} aria-hidden className="shrink-0" />
      <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">
        {questionTitle(d, question)}
      </span>
      <Button size="sm" onClick={answer}>
        {d.dashboard.answer}
      </Button>
    </section>
  )
}
