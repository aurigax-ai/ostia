import { composerAgentName, composerModeOf } from '@/commands/assistCompose'
import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { fmt, useDict } from '@/i18n/useDict'
import { canInsertReference } from '@/lib/agents/sendPick'
import { type ComposerMode, latestRequest, wordDiff } from '@/lib/assist/assistComposer'
import { featureEnabled, setAssistFeature, useAssistFeature } from '@/lib/assist/assistFeatures'
import { redactedCount } from '@/lib/assist/chatRedaction'
import { insertCommand } from '@/lib/terminal/blockActions'
import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { isMac, platform } from '@/platform'
import { useAssistComposerStore } from '@/stores/assist/assistComposerStore'
import { assistRequest, useAssistProvider } from '@/stores/assist/assistStore'
import { ChatCircleDotsIcon, XIcon } from '@phosphor-icons/react'
import type {
  AssistFeatureId,
  AssistProviderInfo,
  AssistResponse,
  CommandSuggestion,
  PromptReview,
} from '@shared/assist'
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

export const TYPO_DEBOUNCE_MS = 700
export const COMMAND_DEBOUNCE_MS = 500
const REDACTION_PREVIEW_MS = 300

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; text: string }
  | { kind: 'note'; text: string }

type Failure = Extract<AssistResponse<'input'>, { ok: false }>

function failureText(d: ReturnType<typeof useDict>, res: Failure): string | null {
  if (res.error === 'cancelled') return null
  if (res.error === 'rate-limited') return d.assist.rateLimited
  return fmt(d.assist.failed, { message: res.message ?? res.error })
}

export function AssistComposer({
  paneId,
  cwd,
  termRef,
}: {
  paneId: string
  cwd?: string
  termRef: RefObject<Xterm | null>
}): JSX.Element | null {
  const openPane = useAssistComposerStore((s) => s.paneId)
  const [mode, setMode] = useState<ComposerMode | null>(null)
  const open = openPane === paneId

  useEffect(() => {
    if (!open) {
      setMode(null)
      return
    }
    const next = composerModeOf(paneId)
    if (next) setMode(next)
    else useAssistComposerStore.getState().close()
  }, [open, paneId])

  if (!open || !mode) return null
  const close = (): void => {
    useAssistComposerStore.getState().close()
    termRef.current?.focus()
  }
  return mode === 'agent' ? (
    <AgentComposer paneId={paneId} onClose={close} />
  ) : (
    <ShellComposer paneId={paneId} cwd={cwd} onClose={close} />
  )
}

function ComposerFrame({
  title,
  provider,
  onClose,
  controls,
  children,
}: {
  title: string
  provider: AssistProviderInfo | null
  onClose: () => void
  controls?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  const d = useDict()
  return (
    <section className="assist-composer" aria-label={title}>
      <header className="assist-composer-head">
        <ChatCircleDotsIcon className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="font-medium text-fg">{title}</span>
        {provider?.label ? (
          <span className="min-w-0 truncate text-fg-muted">
            {fmt(d.assist.via, { label: provider.label })}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {controls}
          <IconButton icon={XIcon} label={d.assist.close} onClick={onClose} />
        </div>
      </header>
      {children}
    </section>
  )
}

function FeatureSwitch({
  id,
  label,
}: {
  id: AssistFeatureId
  label: string
}): JSX.Element | null {
  const ref = useAssistFeature(id)
  if (!ref) return null
  return (
    <span className="flex items-center gap-1.5 text-fg-muted">
      <Switch
        size="sm"
        checked={ref.feature.on}
        aria-label={label}
        onCheckedChange={(on) => void setAssistFeature(id, on)}
      />
      <span aria-hidden="true">{label}</span>
    </span>
  )
}

function StatusLine({ status }: { status: Status }): JSX.Element | null {
  const d = useDict()
  if (status.kind === 'idle') return null
  if (status.kind === 'busy') {
    return (
      <p className="assist-composer-status" aria-live="polite">
        {d.assist.thinking}
      </p>
    )
  }
  return (
    <p
      className="assist-composer-status"
      data-tone={status.kind === 'error' ? 'error' : undefined}
      role={status.kind === 'error' ? 'alert' : 'status'}
    >
      {status.text}
    </p>
  )
}

function RedactedNote({ text }: { text: string }): JSX.Element | null {
  const d = useDict()
  const [count, setCount] = useState(0)
  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      void redactedCount([text]).then((next) => {
        if (!stale) setCount(next)
      })
    }, REDACTION_PREVIEW_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text])
  if (count === 0) return null
  return (
    <output className="assist-composer-status" data-testid="assist-redaction-count">
      {count === 1 ? d.privacy.notSentOne : fmt(d.privacy.notSentMany, { count })}
    </output>
  )
}

function AgentComposer({ paneId, onClose }: { paneId: string; onClose: () => void }): JSX.Element {
  const d = useDict()
  const provider = useAssistProvider('input')
  const agent = useMemo(() => composerAgentName(paneId), [paneId])
  const [text, setText] = useState('')
  const [fix, setFix] = useState<{ for: string; corrected: string } | null>(null)
  const [review, setReview] = useState<PromptReview | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const typos = useRef(latestRequest())
  const reviews = useRef(latestRequest())
  const dict = useRef(d)
  dict.current = d
  const typosOn = featureEnabled(useAssistFeature('typos'))
  const reviewOn = featureEnabled(useAssistFeature('promptReview'))

  useEffect(() => {
    areaRef.current?.focus()
    const pending = [typos.current, reviews.current]
    return () => {
      for (const p of pending) p.cancel()
    }
  }, [])

  useEffect(() => {
    if (!text.trim() || !typosOn) {
      typos.current.cancel()
      setFix(null)
      return
    }
    typos.current.run(async (signal) => {
      const res = await assistRequest('input', { text, tasks: ['typos'], agent }, { signal })
      if (signal.aborted) return
      if (!res.ok) {
        const message = failureText(dict.current, res)
        if (message) setStatus({ kind: 'error', text: message })
        return
      }
      const corrected = res.result.corrected
      setFix(corrected && corrected !== text ? { for: text, corrected } : null)
    }, TYPO_DEBOUNCE_MS)
  }, [text, agent, typosOn])

  const shownFix = fix && fix.for === text ? fix : null

  const acceptFix = (): void => {
    if (!shownFix) return
    setText(shownFix.corrected)
    setFix(null)
  }

  const runReview = (): void => {
    if (!text.trim() || !reviewOn) return
    setReviewing(true)
    reviews.current.run(async (signal) => {
      const res = await assistRequest('input', { text, tasks: ['review'], agent }, { signal })
      if (signal.aborted) return
      setReviewing(false)
      if (!res.ok) {
        const message = failureText(d, res)
        if (message) setStatus({ kind: 'error', text: message })
        return
      }
      setReview(res.result.review ?? null)
    }, 0)
  }

  const paste = async (): Promise<void> => {
    if (!text.trim()) return
    const term = terminalFor(paneId)
    if (term && canInsertReference(paneId)) {
      term.paste(text)
      onClose()
      return
    }
    await navigator.clipboard?.writeText(text).catch(() => undefined)
    setStatus({ kind: 'note', text: fmt(d.assist.copied, { agent }) })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab' && !e.shiftKey && shownFix) {
      e.preventDefault()
      acceptFix()
    } else if (e.key === 'Enter' && mod) {
      e.preventDefault()
      runReview()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void paste()
    }
  }

  const reviewKeys = isMac ? '⌘↵' : 'Ctrl+↵'

  return (
    <ComposerFrame
      title={fmt(d.assist.agentTitle, { agent })}
      provider={provider}
      onClose={onClose}
      controls={
        <>
          <FeatureSwitch id="typos" label={d.terminalGhost.typos} />
          <FeatureSwitch id="promptReview" label={d.terminalGhost.review} />
        </>
      }
    >
      <Textarea
        ref={areaRef}
        rows={2}
        value={text}
        aria-label={fmt(d.assist.agentTitle, { agent })}
        placeholder={fmt(d.assist.agentPlaceholder, { agent })}
        className="assist-composer-area"
        onChange={(e) => {
          setText(e.target.value)
          if (status.kind !== 'idle') setStatus({ kind: 'idle' })
        }}
        onKeyDown={onKeyDown}
      />
      {shownFix ? (
        <div className="assist-composer-fix" data-testid="assist-typo-fix">
          <span className="shrink-0 font-medium text-fg-muted">{d.assist.fixTypos}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg">
            {wordDiff(text, shownFix.corrected).map((part) =>
              part.changed ? (
                <mark key={part.at} className="assist-composer-mark">
                  {part.text}
                </mark>
              ) : (
                <span key={part.at}>{part.text}</span>
              ),
            )}
          </span>
          <Kbd>Tab</Kbd>
        </div>
      ) : null}
      {review ? (
        <div className="assist-composer-review" data-testid="assist-review">
          {review.score !== undefined ? (
            <span className="font-medium text-fg tabular-nums">
              {fmt(d.assist.reviewScore, { score: review.score })}
            </span>
          ) : null}
          {review.notes.length > 0 ? (
            <ul className="assist-composer-notes">
              {review.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : (
            <span className="text-fg-muted">{d.assist.reviewClear}</span>
          )}
        </div>
      ) : null}
      <footer className="assist-composer-foot">
        <StatusLine status={reviewing ? { kind: 'busy' } : status} />
        <RedactedNote text={text} />
        {reviewOn ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={!text.trim() || reviewing}
            onClick={runReview}
          >
            {reviewing ? d.assist.reviewing : d.assist.review}
            <Kbd>{reviewKeys}</Kbd>
          </Button>
        ) : (
          <span className="ml-auto" />
        )}
        <Button size="xs" disabled={!text.trim()} onClick={() => void paste()}>
          {fmt(d.assist.paste, { agent })}
          <Kbd className="bg-transparent text-primary-foreground">↵</Kbd>
        </Button>
      </footer>
    </ComposerFrame>
  )
}

function ShellComposer({
  paneId,
  cwd,
  onClose,
}: {
  paneId: string
  cwd?: string
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const provider = useAssistProvider('command')
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ for: string; suggestions: CommandSuggestion[] } | null>(
    null,
  )
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const pending = useRef(latestRequest())

  useEffect(() => {
    areaRef.current?.focus()
    const request = pending.current
    return () => request.cancel()
  }, [])

  const ask = (query: string, delayMs: number): void => {
    if (!query.trim()) {
      pending.current.cancel()
      setStatus({ kind: 'idle' })
      return
    }
    pending.current.run(async (signal) => {
      setStatus({ kind: 'busy' })
      const res = await assistRequest(
        'command',
        { query, ...(cwd ? { cwd } : {}), platform },
        { signal },
      )
      if (signal.aborted) return
      if (!res.ok) {
        const message = failureText(d, res)
        setStatus(message ? { kind: 'error', text: message } : { kind: 'idle' })
        return
      }
      setIndex(0)
      setResult({ for: query, suggestions: res.result.suggestions })
      setStatus(
        res.result.suggestions.length === 0
          ? { kind: 'note', text: d.assist.noSuggestions }
          : { kind: 'idle' },
      )
    }, delayMs)
  }

  const suggestions = result && result.for === text ? result.suggestions : []

  const insert = (suggestion: CommandSuggestion): void => {
    if (insertCommand(paneId, suggestion.command)) {
      useAssistComposerStore.getState().close()
      return
    }
    setStatus({ kind: 'error', text: d.assist.notAtPrompt })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length > 0) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setIndex((i) => (i + step + suggestions.length) % suggestions.length)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const chosen = suggestions[index]
      if (chosen) insert(chosen)
      else ask(text, 0)
    }
  }

  return (
    <ComposerFrame title={d.assist.shellTitle} provider={provider} onClose={onClose}>
      <Textarea
        ref={areaRef}
        rows={1}
        value={text}
        aria-label={d.assist.shellTitle}
        placeholder={d.assist.shellPlaceholder}
        className="assist-composer-area"
        onChange={(e) => {
          setText(e.target.value)
          ask(e.target.value, COMMAND_DEBOUNCE_MS)
        }}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 ? (
        <Command
          shouldFilter={false}
          value={suggestions[index]?.command}
          onValueChange={(value) => {
            const at = suggestions.findIndex((s) => s.command === value)
            if (at >= 0) setIndex(at)
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="h-auto bg-transparent"
        >
          <CommandList label={d.assist.suggestions} className="assist-composer-list">
            {suggestions.map((s) => (
              <CommandItem
                key={s.command}
                value={s.command}
                className="assist-composer-item"
                onSelect={() => insert(s)}
              >
                <code className="assist-composer-command">{s.command}</code>
                {s.description ? (
                  <span className="truncate text-fg-muted text-ui-xs">{s.description}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      ) : null}
      <footer className="assist-composer-foot">
        <StatusLine status={status} />
        <RedactedNote text={text} />
        {suggestions.length > 0 ? (
          <span className="ml-auto flex items-center gap-1 text-fg-muted">
            {d.assist.insert}
            <Kbd>↵</Kbd>
          </span>
        ) : null}
      </footer>
    </ComposerFrame>
  )
}
