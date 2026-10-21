import type { AssistFeatureId, PromptReview } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { composerAgentName } from '@/commands/assistCompose'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { canInsertReference } from '@/lib/agents/sendPick'
import { fmt, useDict } from '@/lib/app/useDict'
import { latestRequest, wordDiff } from '@/lib/assist/assistComposer'
import { featureEnabled, setAssistFeature, useAssistFeature } from '@/lib/assist/assistFeatures'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { isMac } from '@/platform'
import { assistRequest, useAssistProvider } from '@/stores/assist/assistStore'
import { ComposerFrame, failureText, RedactedNote, type Status, StatusLine } from './ComposerFrame'

const TYPO_DEBOUNCE_MS = 700
function FeatureSwitch({ id, label }: { id: AssistFeatureId; label: string }): JSX.Element | null {
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
function TypoFix({ text, corrected }: { text: string; corrected: string }): JSX.Element {
  const d = useDict()
  return (
    <div className="assist-composer-fix" data-testid="assist-typo-fix">
      <span className="shrink-0 font-medium text-fg-muted">{d.assist.fixTypos}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg">
        {wordDiff(text, corrected).map((part) =>
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
  )
}

function ReviewNotes({ review }: { review: PromptReview }): JSX.Element {
  const d = useDict()
  return (
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
  )
}

function AgentComposerFoot({
  status,
  text,
  agent,
  reviewOn,
  reviewing,
  reviewKeys,
  onReview,
  onPaste,
}: {
  status: Status
  text: string
  agent: string
  reviewOn: boolean
  reviewing: boolean
  reviewKeys: string
  onReview: () => void
  onPaste: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <footer className="assist-composer-foot">
      <StatusLine status={status} />
      <RedactedNote text={text} />
      {reviewOn ? (
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={!text.trim() || reviewing}
          onClick={onReview}
        >
          {reviewing ? d.assist.reviewing : d.assist.review}
          <Kbd>{reviewKeys}</Kbd>
        </Button>
      ) : (
        <span className="ml-auto" />
      )}
      <Button size="xs" disabled={!text.trim()} onClick={onPaste}>
        {fmt(d.assist.paste, { agent })}
        <Kbd className="bg-transparent text-primary-foreground">↵</Kbd>
      </Button>
    </footer>
  )
}

export function AgentPromptComposer({
  paneId,
  onClose,
}: {
  paneId: string
  onClose: () => void
}): JSX.Element {
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
      {shownFix ? <TypoFix text={text} corrected={shownFix.corrected} /> : null}
      {review ? <ReviewNotes review={review} /> : null}
      <AgentComposerFoot
        status={reviewing ? { kind: 'busy' } : status}
        text={text}
        agent={agent}
        reviewOn={reviewOn}
        reviewing={reviewing}
        reviewKeys={reviewKeys}
        onReview={runReview}
        onPaste={() => void paste()}
      />
    </ComposerFrame>
  )
}
