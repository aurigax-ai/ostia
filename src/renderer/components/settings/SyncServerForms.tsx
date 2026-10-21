import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDict } from '@/lib/app/useDict'

export function PassphraseForm({
  label,
  placeholder,
  confirmPlaceholder,
  submit,
  onSubmit,
}: {
  label: string
  placeholder: string
  confirmPlaceholder?: string
  submit: string
  onSubmit: (passphrase: string, confirm: string) => void
}): JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-2 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(passphrase, confirm)
      }}
    >
      <Input
        type="password"
        aria-label={placeholder}
        placeholder={placeholder}
        value={passphrase}
        autoComplete={confirmPlaceholder ? 'new-password' : 'current-password'}
        onChange={(e) => setPassphrase(e.target.value)}
        className="h-7 text-ui-sm"
      />
      {confirmPlaceholder ? (
        <Input
          type="password"
          aria-label={confirmPlaceholder}
          placeholder={confirmPlaceholder}
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          className="h-7 text-ui-sm"
        />
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!passphrase}>
          {submit}
        </Button>
      </div>
    </form>
  )
}

export function RecoveryKeyForm({
  onSubmit,
}: {
  onSubmit: (recoveryKey: string) => void
}): JSX.Element {
  const t = useDict().syncServer
  const [key, setKey] = useState('')
  return (
    <form
      aria-label={t.recover}
      className="flex flex-col gap-2 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(key)
      }}
    >
      <Input
        aria-label={t.recoveryKey}
        placeholder={t.recoveryKey}
        value={key}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setKey(e.target.value)}
        className="h-7 font-mono text-ui-sm"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!key.trim()}>
          {t.recover}
        </Button>
      </div>
    </form>
  )
}

export function RecoveryKeyDialog({
  recoveryKey,
  onClose,
}: {
  recoveryKey: string | null
  onClose: () => void
}): JSX.Element {
  const t = useDict().syncServer
  return (
    <AlertDialog
      open={recoveryKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.recoveryTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.recoveryBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <output className="select-text break-all font-mono text-fg text-ui-base">
          {recoveryKey}
        </output>
        <AlertDialogFooter>
          <AlertDialogAction size="sm" onClick={() => onClose()}>
            {t.recoverySaved}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
