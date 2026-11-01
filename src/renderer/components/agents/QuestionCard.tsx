import { ArrowSquareOutIcon, ChatCircleTextIcon, CheckCircleIcon } from '@phosphor-icons/react'
import type { PermissionChoice } from '@shared/agents/agentPermissions'
import type { QuestionRequest } from '@shared/agents/questions'
import type { Dict } from '@shared/app/dict'
import { type JSX, type KeyboardEvent, useMemo, useState } from 'react'
import { Hint } from '@/components/common/Hint'
import { PromptCard } from '@/components/common/PromptCard'
import { TextLink } from '@/components/common/TextLink'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { isLongContext, type PaneWhere } from '@/lib/agents/needsYou'
import { useAgoText } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useNow } from '@/lib/app/useNow'
import { revealPane } from '@/lib/attention/workspaceActivity'
import { questionPromptKey, useHiddenPromptsStore } from '@/stores/agents/hiddenPromptsStore'
import { EMPTY_DRAFT, type QuestionDraft, useQuestionsStore } from '@/stores/agents/questionsStore'
import { useSettingsStore } from '@/stores/app/settingsStore'

const AGO_TICK_MS = 30_000

function toggled(choices: readonly number[], index: number, on: boolean): number[] {
  const rest = choices.filter((c) => c !== index)
  return on ? [...rest, index].sort((a, b) => a - b) : rest
}

function questionTitle(d: Dict, question: QuestionRequest): string {
  if (!question.permission) return question.question
  return fmt(d.inbox.permissionTitle, {
    agent: d.agentSession[question.permission.agent],
    tool: question.permission.tool,
  })
}

function permissionLabel(d: Dict, choice: PermissionChoice): string {
  if (choice === 'once') return d.approvals.allowOnce
  if (choice === 'always') return d.approvals.allowAlways
  return d.approvals.deny
}

function permissionVariant(choice: PermissionChoice): 'default' | 'outline' | 'destructive' {
  if (choice === 'once') return 'default'
  return choice === 'always' ? 'outline' : 'destructive'
}

function PermissionActions({
  question,
  where,
}: {
  question: QuestionRequest
  where: PaneWhere | null
}): JSX.Element {
  const d = useDict()
  const answer = useQuestionsStore((s) => s.answer)
  const dismiss = useQuestionsStore((s) => s.dismiss)
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {where ? (
        <Button
          variant="ghost"
          size="sm"
          className="mr-auto"
          onClick={() => revealPane(question.paneId)}
        >
          <ArrowSquareOutIcon data-icon="inline-start" />
          {d.inbox.goToPane}
        </Button>
      ) : null}
      <Hint label={d.inbox.permissionInTerminalHint}>
        <Button variant="ghost" size="sm" onClick={() => void dismiss(question.id)}>
          {d.inbox.permissionInTerminal}
        </Button>
      </Hint>
      {(question.choices as PermissionChoice[]).map((choice, index) => (
        <Button
          key={choice}
          size="sm"
          variant={permissionVariant(choice)}
          onClick={() => void answer(question.id, { choices: [index], text: '' })}
        >
          {permissionLabel(d, choice)}
        </Button>
      ))}
    </div>
  )
}

function QuestionHeader({
  question,
  where,
  compact,
}: {
  question: QuestionRequest
  where: PaneWhere | null
  compact: boolean
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const now = useNow(AGO_TICK_MS)
  const ago = useAgoText()
  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-muted text-ui-xs">
      <ChatCircleTextIcon size={16} aria-hidden className="shrink-0" />
      {compact ? (
        <span className="truncate font-medium text-fg">
          {where?.pane ?? d.attention.closedPane}
        </span>
      ) : (
        <>
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
        </>
      )}
      <time dateTime={new Date(question.at).toISOString()} className="tabular-nums">
        {ago(now - question.at)}
      </time>
      {question.expiresAt !== undefined ? (
        <span className="tabular-nums">
          {fmt(d.inbox.waitsUntil, { time: clock.format(new Date(question.expiresAt)) })}
        </span>
      ) : null}
    </header>
  )
}

function QuestionContext({ question }: { question: QuestionRequest }): JSX.Element | null {
  const d = useDict()
  const [expanded, setExpanded] = useState(false)
  const ids = `question-${question.id}`
  const longContext = isLongContext(question.context)
  if (!question.context) return null
  return (
    <div className="flex flex-col items-start gap-1">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label names the block for screen readers and tests; a role would change how it is announced */}
      <p
        id={`${ids}-context`}
        aria-label={d.inbox.context}
        className={`whitespace-pre-wrap text-fg-muted text-ui-sm [overflow-wrap:anywhere] ${
          question.permission ? 'font-mono' : ''
        } ${longContext && !expanded ? 'line-clamp-4' : ''}`}
      >
        {question.context}
      </p>
      {longContext ? (
        <TextLink
          size="xs"
          className="h-auto p-0 text-ui-xs"
          aria-expanded={expanded}
          aria-controls={`${ids}-context`}
          onClick={() => setExpanded((on) => !on)}
        >
          {expanded ? d.inbox.showLess : d.inbox.showMore}
        </TextLink>
      ) : null}
    </div>
  )
}

function AnswerForm({
  question,
  where,
}: {
  question: QuestionRequest
  where: PaneWhere | null
}): JSX.Element {
  const d = useDict()
  const draft = useQuestionsStore((s) => s.drafts[question.id]) ?? EMPTY_DRAFT
  const setDraft = useQuestionsStore((s) => s.setDraft)
  const answer = useQuestionsStore((s) => s.answer)
  const dismiss = useQuestionsStore((s) => s.dismiss)
  const ids = `question-${question.id}`
  const hasChoices = question.mode !== 'text'
  const canSend = draft.choices.length > 0 || draft.text.trim() !== ''
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
    <>
      {question.mode === 'single' ? (
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1 text-fg-muted text-ui-xs">{d.inbox.chooseOne}</legend>
          <RadioGroup
            aria-label={d.inbox.chooseOne}
            value={draft.choices[0] ?? null}
            onValueChange={(value) => update({ choices: [value as number] })}
            className="flex flex-col gap-0"
          >
            {question.choices.map((choice, index) => (
              <label
                key={choice}
                htmlFor={`${ids}-choice-${index}`}
                className={`flex items-center gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2${draft.choices[0] === index ? ' bg-surface-2' : ''}`}
              >
                <RadioGroupItem id={`${ids}-choice-${index}`} value={index} />
                <span className="min-w-0 [overflow-wrap:anywhere]">{choice}</span>
              </label>
            ))}
          </RadioGroup>
          {draft.choices.length > 0 ? (
            <TextLink
              size="xs"
              className="h-auto self-start p-0 px-2 text-ui-xs"
              onClick={() => update({ choices: [] })}
            >
              {d.inbox.clearChoice}
            </TextLink>
          ) : null}
        </fieldset>
      ) : null}

      {question.mode === 'multi' ? (
        <fieldset className="flex min-w-0 flex-col gap-0">
          <legend className="mb-1 text-fg-muted text-ui-xs">{d.inbox.chooseAny}</legend>
          {question.choices.map((choice, index) => (
            <label
              key={choice}
              htmlFor={`${ids}-choice-${index}`}
              className={`flex items-center gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2${draft.choices.includes(index) ? ' bg-surface-2' : ''}`}
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
          {hasChoices ? d.inbox.comment : d.inbox.reply}
        </Label>
        <Textarea
          id={`${ids}-reply`}
          value={draft.text}
          placeholder={hasChoices ? d.inbox.commentPlaceholder : d.inbox.replyPlaceholder}
          onChange={(e) => update({ text: e.target.value })}
          onKeyDown={onReplyKey}
          className="min-h-9 text-ui-sm"
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {where && !question.source ? (
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            onClick={() => revealPane(question.paneId)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {d.inbox.goToPane}
          </Button>
        ) : null}
        <Hint label={d.inbox.dismissHint}>
          <Button variant="ghost" size="sm" onClick={() => void dismiss(question.id)}>
            {d.inbox.dismiss}
          </Button>
        </Hint>
        <Button size="sm" disabled={!canSend} onClick={send}>
          {d.inbox.send}
        </Button>
      </div>
    </>
  )
}

export function QuestionCard({
  question,
  where,
  sent = false,
  compact = false,
}: {
  question: QuestionRequest
  where: PaneWhere | null
  sent?: boolean
  compact?: boolean
}): JSX.Element {
  const d = useDict()
  return (
    <article
      aria-label={fmt(d.inbox.question, { pane: where?.pane ?? d.attention.closedPane })}
      data-question={question.id}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3 text-fg text-ui-base"
    >
      <QuestionHeader question={question} where={where} compact={compact} />

      <h3 className="font-medium text-ui-emphasis [overflow-wrap:anywhere]">
        {questionTitle(d, question)}
      </h3>

      <QuestionContext question={question} />

      {sent ? (
        <output className="flex items-center gap-1.5 text-ok text-ui-sm">
          <CheckCircleIcon size={16} aria-hidden />
          {d.inbox.sent}
        </output>
      ) : question.permission ? (
        <PermissionActions question={question} where={where} />
      ) : (
        <AnswerForm question={question} where={where} />
      )}
    </article>
  )
}

export function QuestionPrompt({ question }: { question: QuestionRequest }): JSX.Element {
  const d = useDict()
  const hide = useHiddenPromptsStore((s) => s.hide)
  return (
    <PromptCard
      icon={ChatCircleTextIcon}
      label={d.inbox.questionNotice}
      data-question={question.id}
      title={questionTitle(d, question)}
      dismissLabel={d.inbox.decideLater}
      onDismiss={() => hide(questionPromptKey(question.id))}
    >
      <div className="flex flex-col gap-2 text-fg">
        <QuestionContext question={question} />
        {question.permission ? (
          <PermissionActions question={question} where={null} />
        ) : (
          <AnswerForm question={question} where={null} />
        )}
      </div>
    </PromptCard>
  )
}
