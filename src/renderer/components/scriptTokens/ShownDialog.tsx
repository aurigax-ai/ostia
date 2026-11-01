import { CheckIcon, CopyIcon, InfoIcon } from '@phosphor-icons/react'
import type { ScriptTokenInfo, ScriptTokensState } from '@shared/permissions/scriptTokens'
import { type JSX, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import { ScopeSummary, Stat } from './TokenSummary'
import { reachedCount, runsCommands, shownCaps } from './tokenScope'
import { ENV, EXAMPLE, localDate, masked } from './tokenText'

export type Shown = { title: string; value: string; token: ScriptTokenInfo }

export function CodeBlock({ lines }: { lines: string[] }): JSX.Element {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-bg-sunken px-3 py-2 font-mono text-fg text-ui-sm">
      {lines.map((line) => (
        <div key={line}>
          <span className="select-none text-fg-dim">$ </span>
          {line}
        </div>
      ))}
    </pre>
  )
}

export function ShownDialog({
  shown,
  state,
  onClose,
}: {
  shown: Shown
  state: ScriptTokensState
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const [copied, setCopied] = useState(false)
  const { token, value } = shown
  const caps = shownCaps(token.caps)
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open) details.cancel()
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader className="flex-row items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-brand">
            <CheckIcon className="size-4" />
          </span>
          <div className="flex flex-col gap-1.5">
            <DialogTitle>{shown.title}</DialogTitle>
            <DialogDescription>{t.copyNow}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label={t.tokenValue}
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 font-mono text-ui-sm"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied ? t.copied : t.copy}
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label={t.access}>
            <span className="inline-flex flex-wrap items-center gap-x-0.5">
              <ScopeSummary scope={token.scope} state={state} />
              {` (${reachedCount(token.scope, state)})`}
            </span>
          </Stat>
          <Stat label={t.permissions}>
            {fmt(t.permissionCount, { n: caps.length })}
            {runsCommands(caps) ? ` · ${t.canRunCommands}` : ''}
          </Stat>
          <Stat label={t.detailExpires}>
            {token.expiresAt ? localDate(token.expiresAt) : t.neverExpires}
          </Stat>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-fg text-ui-sm">{t.useInScript}</span>
          <CodeBlock lines={[`export ${ENV}=${masked(value)}`, EXAMPLE]} />
        </div>
        <p className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-fg-muted text-ui-sm">
          <InfoIcon className="mt-0.5 size-4 shrink-0" />
          {t.hashOnly}
        </p>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            {t.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
