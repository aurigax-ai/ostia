import { WarningIcon } from '@phosphor-icons/react'
import {
  type PublishOptions,
  SHARE_DEFAULT_EXPIRY_SECONDS,
  SHARE_EXPIRIES_SECONDS,
  SHARE_NEVER_EXPIRES,
  SHARE_PASSWORD_MIN,
  type ShareFinding,
  type ShareMode,
  type ShareView,
} from '@shared/artifacts/shares'
import { type JSX, useId, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { DATE_ONLY, formatDate } from '@/lib/app/localeFormat'
import { useCopied } from '@/lib/app/useCopied'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSharesStore } from '@/stores/files/sharesStore'
import { publishProblemText } from './shareText'
import type { Publishing } from './usePublishing'

type Stage =
  | { kind: 'form'; problem: string | null }
  | { kind: 'busy' }
  | { kind: 'findings'; findings: ShareFinding[]; digest: string }
  | { kind: 'done'; share: ShareView; password: boolean }

function expiryLabels(d: ReturnType<typeof useDict>): Record<number, string> {
  return {
    86400: d.shares.expiry1d,
    604800: d.shares.expiry7d,
    2592000: d.shares.expiry30d,
    31536000: d.shares.expiry1y,
    [SHARE_NEVER_EXPIRES]: d.shares.expiryNever,
  }
}

function ModeChoice({
  id,
  value,
  picked,
  title,
  desc,
}: {
  id: string
  value: ShareMode
  picked: ShareMode
  title: string
  desc: string
}): JSX.Element {
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2${value === picked ? ' bg-surface-2' : ''}`}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{title}</span>
        <span className="text-fg-muted text-ui-xs">{desc}</span>
      </span>
    </label>
  )
}

function Findings({ findings }: { findings: ShareFinding[] }): JSX.Element {
  const d = useDict()
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ui-sm">{d.shares.findingsBody}</p>
      <ul className="flex flex-col gap-0.5" data-testid="share-findings">
        {findings.map((f) => (
          <li key={`${f.line}-${f.kind}-${f.masked}`} className="font-mono text-ui-xs">
            {fmt(d.shares.findingLine, { kind: f.kind, line: f.line, masked: f.masked })}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Done({
  share,
  password,
  onCopied,
}: {
  share: ShareView
  password: boolean
  onCopied: () => void
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [copied, markCopied] = useCopied()
  const when =
    share.expiresAt === SHARE_NEVER_EXPIRES
      ? d.shares.doneNever
      : fmt(d.shares.doneExpires, { date: formatDate(share.expiresAt, locale, DATE_ONLY) })
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ui-sm">{when}</p>
      {password ? <p className="text-fg-muted text-ui-sm">{d.shares.donePassword}</p> : null}
      <div>
        <Button
          size="sm"
          onClick={() =>
            void window.ostia.shares.copyLink(share.id).then((r) => {
              if (!r.ok) return
              markCopied()
              onCopied()
            })
          }
        >
          {copied ? d.shares.copied : d.shares.copyLink}
        </Button>
      </div>
    </div>
  )
}

function Form({
  allowPublic,
  allowNever,
  options,
  onChange,
  problem,
}: {
  allowPublic: boolean
  allowNever: boolean
  options: Omit<PublishOptions, 'acceptedDigest'>
  onChange: (next: Omit<PublishOptions, 'acceptedDigest'>) => void
  problem: string | null
}): JSX.Element {
  const d = useDict()
  const ids = useId()
  const labels = expiryLabels(d)
  const choices = [...SHARE_EXPIRIES_SECONDS, ...(allowNever ? [SHARE_NEVER_EXPIRES] : [])]
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        aria-label={d.shares.modeLabel}
        value={options.mode}
        onValueChange={(mode) => onChange({ ...options, mode: mode as ShareMode })}
        className="flex flex-col gap-0"
      >
        <ModeChoice
          id={`${ids}-link`}
          value="link"
          picked={options.mode}
          title={d.shares.modeLink}
          desc={d.shares.modeLinkDesc}
        />
        <ModeChoice
          id={`${ids}-password`}
          value="password"
          picked={options.mode}
          title={d.shares.modePassword}
          desc={d.shares.modePasswordDesc}
        />
        {allowPublic ? (
          <ModeChoice
            id={`${ids}-public`}
            value="public"
            picked={options.mode}
            title={d.shares.modePublic}
            desc={d.shares.modePublicDesc}
          />
        ) : null}
      </RadioGroup>
      {options.mode === 'password' ? (
        <div className="flex flex-col gap-1.5">
          <Input
            type="password"
            aria-label={d.shares.passwordLabel}
            placeholder={d.shares.passwordLabel}
            autoComplete="new-password"
            value={options.password}
            onChange={(e) => onChange({ ...options, password: e.target.value })}
            className="h-7 text-ui-sm"
          />
          <p className="text-fg-muted text-ui-xs">
            {fmt(d.shares.passwordHint, { min: SHARE_PASSWORD_MIN })}
          </p>
          <label htmlFor={`${ids}-key`} className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              id={`${ids}-key`}
              checked={options.withLinkKey}
              onCheckedChange={(on) => onChange({ ...options, withLinkKey: on === true })}
            />
            {d.shares.passwordWithKey}
          </label>
        </div>
      ) : null}
      {options.mode === 'public' ? <Notice>{d.shares.publicWarning}</Notice> : null}
      <div className="flex items-center gap-2 text-ui-sm">
        <span>{d.shares.expiryLabel}</span>
        <Select
          value={String(options.expiresInSeconds)}
          onValueChange={(v) => onChange({ ...options, expiresInSeconds: Number(v) })}
        >
          <SelectTrigger size="sm" aria-label={d.shares.expiryLabel} className="w-fit min-w-32">
            <span className="min-w-0 truncate">{labels[options.expiresInSeconds]}</span>
          </SelectTrigger>
          <SelectContent>
            {choices.map((seconds) => (
              <SelectItem key={seconds} value={String(seconds)}>
                {labels[seconds]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Notice tone="info">{d.shares.limit}</Notice>
      {problem ? (
        <p role="alert" className="flex items-center gap-1.5 text-attn-fg text-ui-sm">
          <WarningIcon size={16} aria-hidden />
          {problem}
        </p>
      ) : null}
    </div>
  )
}

function PublishBody({ publishing }: { publishing: Publishing }): JSX.Element {
  const d = useDict()
  const availability = useSharesStore((s) => s.availability)
  const ready = availability?.state === 'ready' ? availability : null
  const [stage, setStage] = useState<Stage>({ kind: 'form', problem: null })
  const [options, setOptions] = useState<Omit<PublishOptions, 'acceptedDigest'>>({
    mode: 'link',
    password: '',
    withLinkKey: false,
    expiresInSeconds: SHARE_DEFAULT_EXPIRY_SECONDS,
  })
  const weak =
    options.mode === 'password' && Array.from(options.password).length < SHARE_PASSWORD_MIN

  const submit = async (acceptedDigest: string): Promise<void> => {
    setStage({ kind: 'busy' })
    const result = await publishing.publish({ ...options, acceptedDigest })
    if (result?.ok && result.share) {
      useSharesStore.getState().added(result.share)
      setStage({ kind: 'done', share: result.share, password: options.mode === 'password' })
      return
    }
    if (result && !result.ok && result.reason === 'findings' && result.findings) {
      setStage({
        kind: 'findings',
        findings: result.findings,
        digest: result.findingsDigest ?? '',
      })
      return
    }
    setStage({
      kind: 'form',
      problem: result && !result.ok ? publishProblemText(d, result) : d.shares.errFailed,
    })
  }

  return (
    <DialogContent showCloseButton={false} className="w-[min(90vw,32rem)] max-w-none sm:max-w-none">
      <DialogHeader>
        <DialogTitle>
          {stage.kind === 'findings'
            ? d.shares.findingsTitle
            : stage.kind === 'done'
              ? d.shares.doneTitle
              : fmt(d.shares.dialogTitle, { name: publishing.name })}
        </DialogTitle>
        <DialogDescription>{d.shares.dialogDesc}</DialogDescription>
      </DialogHeader>
      {stage.kind === 'findings' ? <Findings findings={stage.findings} /> : null}
      {stage.kind === 'done' ? (
        <Done share={stage.share} password={stage.password} onCopied={publishing.linkCopied} />
      ) : null}
      {stage.kind === 'form' || stage.kind === 'busy' ? (
        <Form
          allowPublic={ready?.allowPublic === true}
          allowNever={ready?.allowNever === true}
          options={options}
          onChange={setOptions}
          problem={stage.kind === 'form' ? stage.problem : null}
        />
      ) : null}
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={publishing.hide}>
          {stage.kind === 'done' ? d.shares.close : d.shares.cancel}
        </Button>
        {stage.kind === 'findings' ? (
          <Button variant="destructive" size="sm" onClick={() => void submit(stage.digest)}>
            {d.shares.publishAnyway}
          </Button>
        ) : null}
        {stage.kind === 'form' || stage.kind === 'busy' ? (
          <Button
            size="sm"
            disabled={stage.kind === 'busy' || weak || ready === null}
            onClick={() => void submit('')}
          >
            {stage.kind === 'busy' ? d.shares.publishing : d.shares.publish}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogContent>
  )
}

export function PublishDialog({ publishing }: { publishing: Publishing }): JSX.Element {
  return (
    <Dialog
      open={publishing.open}
      onOpenChange={(next) => {
        if (!next) publishing.hide()
      }}
    >
      {publishing.open ? <PublishBody publishing={publishing} /> : null}
    </Dialog>
  )
}
