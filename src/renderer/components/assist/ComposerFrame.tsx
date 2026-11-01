import type {
  AssistProviderInfo,
  AssistResponse,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { ChatCircleDotsIcon, XIcon } from '@phosphor-icons/react'
import { type JSX, useEffect, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/lib/app/useDict'
import { redactedCount } from '@/lib/assist/chatRedaction'

const REDACTION_PREVIEW_MS = 300
export type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; text: string }
  | { kind: 'note'; text: string }

type Failure = Extract<AssistResponse<'input'>, { ok: false }>

export function failureText(d: ReturnType<typeof useDict>, res: Failure): string | null {
  if (res.error === 'cancelled') return null
  if (res.error === 'rate-limited') return d.assist.rateLimited
  return fmt(d.assist.failed, { message: res.message ?? res.error })
}
export function ComposerFrame({
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
        <ChatCircleDotsIcon className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
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
export function StatusLine({ status }: { status: Status }): JSX.Element | null {
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

export function RedactedNote({ text }: { text: string }): JSX.Element | null {
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
