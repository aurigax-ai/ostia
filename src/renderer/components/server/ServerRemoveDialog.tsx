import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'

export interface RemoveTarget {
  id: string
  name: string
}

export function ServerRemoveDialog({
  target,
  syncing,
  error,
  onClose,
  onConfirm,
}: {
  target: RemoveTarget | null
  syncing: boolean
  error: string | null
  onClose: () => void
  onConfirm: (target: RemoveTarget, passphrase: string, recoveryKey: string) => void
}): JSX.Element {
  const d = useDict()
  const [passphrase, setPassphrase] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {fmt(d.server.removeTitle, { name: target?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {fmt(d.server.removeBody, { name: target?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {syncing ? (
          <div className="flex flex-col gap-2">
            <Input
              type="password"
              aria-label={d.server.removePassphrase}
              placeholder={d.server.removePassphrase}
              value={passphrase}
              autoComplete="current-password"
              onChange={(e) => setPassphrase(e.target.value)}
              className="h-7 text-ui-sm"
            />
            <p className="text-fg-muted text-ui-sm">{d.server.removePassphraseDesc}</p>
            <Input
              aria-label={d.server.removeRecovery}
              placeholder={d.server.removeRecovery}
              value={recoveryKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRecoveryKey(e.target.value)}
              className="h-7 font-mono text-ui-sm"
            />
            <p className="text-fg-muted text-ui-sm">{d.server.removeRecoveryDesc}</p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-attn-fg text-ui-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">{d.server.cancel}</AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={syncing && passphrase === ''}
            onClick={(e) => {
              e.preventDefault()
              if (target) onConfirm(target, passphrase, recoveryKey)
            }}
          >
            {d.server.removeConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
