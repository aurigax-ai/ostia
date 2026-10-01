import { ArrowSquareOutIcon, ChatCircleTextIcon, CheckCircleIcon } from '@phosphor-icons/react'
import type { QuestionRequest } from '@shared/questions'
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { type PaneWhere, agoText, isLongContext } from '../lib/dashboard'
import { revealPane } from '../lib/workspaceActivity'
import { EMPTY_DRAFT, type QuestionDraft, useQuestionsStore } from '../stores/questionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Hint } from './Hint'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'
import { Textarea } from './ui/textarea'

const AGO_TICK_MS = 30_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGO_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function toggled(choices: readonly number[], index: number, on: boolean): number[] {
  const rest = choices.filter((c) => c !== index)
  return on ? [...rest, index].sort((a, b) => a - b) : rest
}

export function QuestionCard({
  question,
  where,
  sent = false,
}: {
  question: QuestionRequest
  where: PaneWhere | null
  sent?: boolean
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const draft = useQuestionsStore((s) => s.drafts[question.id]) ?? EMPTY_DRAFT
  const setDraft = useQuestionsStore((s) => s.setDraft)
  const answer = useQuestionsStore((s) => s.answer)
  const dismiss = useQuestionsStore((s) => s.dismiss)
  const [expanded, setExpanded] = useState(false)
  const now = useNow()
  const relative = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }),
    [locale],
  )
  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )
  const ids = `question-${question.id}`
  const hasChoices = question.mode !== 'text'
  const canSend = draft.choices.length > 0 || draft.text.trim() !== ''
  const longContext = isLongContext(question.context)
  const update = (patch: Partial<QuestionDraft>): void =>
    setDraft(question.id, { ...draft, ...patch })

  const send = (): void => {
    if (canSend) void answer(question.id, { choices: draft.choices, text: draft.text })
  }

  const onReplyKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }

  return (
    <article
      aria-label={fmt(d.dashboard.question, { pane: where?.pane ?? d.attention.closedPane })}
      data-question={question.id}
      className="dashboard-card flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3 text-fg text-ui-base"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-muted text-ui-xs">
        <ChatCircleTextIcon size={14} aria-hidden className="shrink-0" />
        <span className="truncate font-medium text-fg">
          {where?.workspace ?? d.attention.closedPane}
        </span>
        {where ? (
          <>
            <Hint label={where.path}>
              <span className="truncate font-mono">{where.shortPath}</span>
            </Hint>
            <span className="truncate">{where.pane}</span>
          </>
        ) : null}
        <time dateTime={new Date(question.at).toISOString()} className="tabular-nums">
          {agoText(now - question.at, d.dashboard.justNow, relative)}
        </time>
        {question.expiresAt !== undefined ? (
          <span className="tabular-nums">
            {fmt(d.dashboard.waitsUntil, { time: clock.format(new Date(question.expiresAt)) })}
          </span>
        ) : null}
      </header>

      <h3 className="font-medium text-ui-emphasis [overflow-wrap:anywhere]">{question.question}</h3>

      {question.context ? (
        <div className="flex flex-col items-start gap-1">
          <p
            id={`${ids}-context`}
            aria-label={d.dashboard.context}
            className={`whitespace-pre-wrap text-fg-muted text-ui-sm [overflow-wrap:anywhere] ${
              longContext && !expanded ? 'line-clamp-4' : ''
            }`}
          >
            {question.context}
          </p>
          {longContext ? (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-ui-xs"
              aria-expanded={expanded}
              aria-controls={`${ids}-context`}
              onClick={() => setExpanded((on) => !on)}
            >
              {expanded ? d.dashboard.showLess : d.dashboard.showMore}
            </Button>
          ) : null}
        </div>
      ) : null}

      {sent ? (
        <output className="flex items-center gap-1.5 text-ok text-ui-sm">
          <CheckCircleIcon size={14} aria-hidden />
          {d.dashboard.sent}
        </output>
      ) : (
        <>
          {question.mode === 'single' ? (
            <fieldset className="flex min-w-0 flex-col gap-1">
              <legend className="mb-1 text-fg-muted text-ui-xs">{d.dashboard.chooseOne}</legend>
              <RadioGroup
                aria-label={d.dashboard.chooseOne}
                value={draft.choices[0] ?? null}
                onValueChange={(value) => update({ choices: [value as number] })}
                className="flex flex-col gap-0"
              >
                {question.choices.map((choice, index) => (
                  <label
                    key={choice}
                    htmlFor={`${ids}-choice-${index}`}
                    className="flex items-center gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2 has-data-checked:bg-surface-2"
                  >
                    <RadioGroupItem id={`${ids}-choice-${index}`} value={index} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{choice}</span>
                  </label>
                ))}
              </RadioGroup>
              {draft.choices.length > 0 ? (
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto self-start p-0 px-2 text-ui-xs"
                  onClick={() => update({ choices: [] })}
                >
                  {d.dashboard.clearChoice}
                </Button>
              ) : null}
            </fieldset>
          ) : null}

          {question.mode === 'multi' ? (
            <fieldset className="flex min-w-0 flex-col gap-0">
              <legend className="mb-1 text-fg-muted text-ui-xs">{d.dashboard.chooseAny}</legend>
              {question.choices.map((choice, index) => (
                <label
                  key={choice}
                  htmlFor={`${ids}-choice-${index}`}
                  className="flex items-center gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2 has-data-checked:bg-surface-2"
                >
                  <Checkbox
                    id={`${ids}-choice-${index}`}
                    checked={draft.choices.includes(index)}
                    onCheckedChange={(on) =>
                      update({ choices: toggled(draft.choices, index, on === true) })
                    }
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{choice}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-reply`} className="font-normal text-fg-muted text-ui-xs">
              {hasChoices ? d.dashboard.comment : d.dashboard.reply}
            </Label>
            <Textarea
              id={`${ids}-reply`}
              value={draft.text}
              placeholder={
                hasChoices ? d.dashboard.commentPlaceholder : d.dashboard.replyPlaceholder
              }
              onChange={(e) => update({ text: e.target.value })}
              onKeyDown={onReplyKey}
              className="min-h-9 text-ui-sm"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {where ? (
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto"
                onClick={() => revealPane(question.paneId)}
              >
                <ArrowSquareOutIcon data-icon="inline-start" />
                {d.dashboard.goToPane}
              </Button>
            ) : null}
            <Hint label={d.dashboard.dismissHint}>
              <Button variant="ghost" size="sm" onClick={() => void dismiss(question.id)}>
                {d.dashboard.dismiss}
              </Button>
            </Hint>
            <Button size="sm" disabled={!canSend} onClick={send}>
              {d.dashboard.send}
            </Button>
          </div>
        </>
      )}
    </article>
  )
}
