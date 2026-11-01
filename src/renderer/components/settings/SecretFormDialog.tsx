import { type JSX, useState } from 'react'
import { TextLink } from '@/components/common/TextLink'
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
import { useCopied } from '@/lib/app/useCopied'
import { useDict } from '@/lib/app/useDict'

interface SecretField {
  name: string
  label: string
  secret: boolean
  autoComplete: string
}

export interface SecretOutcome {
  ok: boolean
  error?: string
  recoveryKey?: string
}

export interface SecretStep {
  title: string
  desc: string
  fields: SecretField[]
  submit: string
  link?: { label: string; onClick: () => void }
  later?: boolean
  onSubmit: (values: Record<string, string>) => Promise<SecretOutcome>
}

export interface RecoveryText {
  title: string
  desc: string
}

function RecoveryView({
  recoveryKey,
  text,
  onClose,
}: {
  recoveryKey: string
  text: RecoveryText
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const [copied, markCopied] = useCopied()
  return (
    <>
      <DialogHeader>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.desc}</DialogDescription>
      </DialogHeader>
      <output className="select-text break-all font-mono text-fg text-ui-base">
        {recoveryKey}
      </output>
      <DialogFooter>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(recoveryKey).then(markCopied)}
        >
          {copied ? d.sync.copied : d.sync.copy}
        </Button>
        <Button size="sm" onClick={onClose}>
          {d.sync.recoverySaved}
        </Button>
      </DialogFooter>
    </>
  )
}

function FormView({
  step,
  onDone,
  onClose,
}: {
  step: SecretStep
  onDone: (outcome: SecretOutcome) => void
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const filled = step.fields.every((f) => (values[f.name] ?? '') !== '')

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const outcome = await step.onSubmit(values)
      setError(outcome.ok ? null : (outcome.error ?? null))
      if (outcome.ok) onDone(outcome)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label={step.title}
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        if (filled && !busy) void submit()
      }}
    >
      <DialogHeader>
        <DialogTitle>{step.title}</DialogTitle>
        <DialogDescription>{step.desc}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        {step.fields.map((field) => (
          <Input
            key={field.name}
            type={field.secret ? 'password' : 'text'}
            aria-label={field.label}
            placeholder={field.label}
            value={values[field.name] ?? ''}
            autoComplete={field.autoComplete}
            spellCheck={false}
            onChange={(e) => setValues((all) => ({ ...all, [field.name]: e.target.value }))}
            className={field.secret ? 'h-7 text-ui-sm' : 'h-7 font-mono text-ui-sm'}
          />
        ))}
        {error ? (
          <p role="alert" className="text-attn-fg text-ui-sm">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        {step.link ? (
          <TextLink size="sm" className="h-auto px-0 sm:mr-auto" onClick={step.link.onClick}>
            {step.link.label}
          </TextLink>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {step.later ? d.sync.later : d.sync.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={!filled || busy}>
          {step.submit}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function SecretFormDialog({
  step,
  recovery,
  onClose,
}: {
  step: SecretStep | null
  recovery: RecoveryText
  onClose: () => void
}): JSX.Element {
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const close = (): void => {
    setRecoveryKey(null)
    onClose()
  }
  return (
    <Dialog
      open={step !== null || recoveryKey !== null}
      onOpenChange={(open) => {
        if (!open && recoveryKey === null) close()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {recoveryKey !== null ? (
          <RecoveryView recoveryKey={recoveryKey} text={recovery} onClose={close} />
        ) : step ? (
          <FormView
            key={step.title}
            step={step}
            onClose={close}
            onDone={(outcome) => {
              if (outcome.recoveryKey) setRecoveryKey(outcome.recoveryKey)
              else close()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
