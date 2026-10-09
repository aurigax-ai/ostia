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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useDict } from '@/i18n/useDict'
import type { Dict } from '@shared/dict'
import type { SecretActionResult, SyncStatus } from '@shared/types'
import { useState } from 'react'
import { ControlRow, SectionHead, WarningNote } from './SettingsPanel'

type Form = 'unlock' | 'recover' | 'change' | 'reset' | null
type Confirming = 'remove' | 'reset' | null

function secretErrorText(d: Dict, error: string | undefined): string {
  const t = d.sync.secrets.errors
  switch (error) {
    case 'too-short':
      return t.tooShort
    case 'mismatch':
      return t.mismatch
    case 'wrong-password':
      return t.wrongPassword
    case 'wrong-recovery-key':
      return t.wrongRecoveryKey
    case 'exists':
      return t.exists
    case 'damaged':
      return t.damaged
    case 'no-bundle':
      return t.noBundle
    default:
      return t.failed
  }
}

function PasswordFields({
  d,
  label,
  withConfirm,
  withRecoveryKey,
  submit,
  onSubmit,
}: {
  d: Dict
  label: string
  withConfirm: boolean
  withRecoveryKey?: boolean
  submit: string
  onSubmit: (fields: { recoveryKey: string; password: string; confirm: string }) => void
}): JSX.Element {
  const t = d.sync.secrets
  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-2 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ recoveryKey, password, confirm })
      }}
    >
      {withRecoveryKey ? (
        <Input
          aria-label={t.recoveryKey}
          placeholder={t.recoveryKey}
          value={recoveryKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setRecoveryKey(e.target.value)}
          className="h-7 font-mono text-ui-sm"
        />
      ) : null}
      <Input
        type="password"
        aria-label={withConfirm ? t.newPassword : t.password}
        placeholder={withConfirm ? t.newPassword : t.password}
        value={password}
        autoComplete={withConfirm ? 'new-password' : 'current-password'}
        onChange={(e) => setPassword(e.target.value)}
        className="h-7 text-ui-sm"
      />
      {withConfirm ? (
        <Input
          type="password"
          aria-label={t.confirmPassword}
          placeholder={t.confirmPassword}
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          className="h-7 text-ui-sm"
        />
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!password}>
          {submit}
        </Button>
      </div>
    </form>
  )
}

export function SyncSecretsSection({
  status,
  onStatus,
}: {
  status: SyncStatus
  onStatus: (status: SyncStatus) => void
}): JSX.Element {
  const d = useDict()
  const t = d.sync.secrets
  const api = window.ostia.sync.secrets
  const state = status.secrets.state
  const [form, setForm] = useState<Form>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [error, setError] = useState<string | null>(null)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)

  const act = async (work: Promise<SecretActionResult>): Promise<boolean> => {
    const res = await work
    onStatus(res.status)
    setError(res.ok ? null : secretErrorText(d, res.error))
    if (res.recoveryKey) setRecoveryKey(res.recoveryKey)
    if (res.ok) setForm(null)
    return res.ok
  }

  const shownForm: Form = state === 'locked' && form === null ? 'unlock' : form

  return (
    <section aria-label={t.title} className="mt-4">
      <SectionHead title={t.title} desc={t.desc} />
      <ControlRow label={t.toggle} desc={t.toggleDesc}>
        <Switch
          aria-label={t.toggle}
          checked={state !== 'off'}
          onCheckedChange={(on) => void act(on ? api.enable() : api.disable())}
        />
      </ControlRow>
      {state === 'needs-setup' ? (
        <ControlRow label={t.setupTitle} desc={t.setupDesc}>
          <PasswordFields
            d={d}
            label={t.setupTitle}
            withConfirm
            submit={t.setup}
            onSubmit={(f) => void act(api.setup(f.password, f.confirm))}
          />
        </ControlRow>
      ) : null}
      {state === 'locked' || state === 'damaged' ? (
        <WarningNote
          actions={
            <>
              {state === 'locked' ? (
                <Button variant="ghost" size="sm" onClick={() => setForm('recover')}>
                  {t.useRecoveryKey}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setConfirming('reset')}>
                {t.reset}
              </Button>
            </>
          }
        >
          {state === 'locked' ? t.locked : t.damaged}
        </WarningNote>
      ) : null}
      {shownForm === 'unlock' && state === 'locked' ? (
        <PasswordFields
          d={d}
          label={t.unlockTitle}
          withConfirm={false}
          submit={t.unlock}
          onSubmit={(f) => void act(api.unlock(f.password))}
        />
      ) : null}
      {shownForm === 'recover' ? (
        <PasswordFields
          d={d}
          label={t.recoverTitle}
          withConfirm
          withRecoveryKey
          submit={t.recover}
          onSubmit={(f) => void act(api.recover(f.recoveryKey, f.password, f.confirm))}
        />
      ) : null}
      {shownForm === 'reset' ? (
        <PasswordFields
          d={d}
          label={t.resetTitle}
          withConfirm
          submit={t.reset}
          onSubmit={(f) => void act(api.reset(f.password, f.confirm))}
        />
      ) : null}
      {state === 'unlocked' ? (
        <>
          <ControlRow label={t.logins} desc={t.loginsDesc}>
            <Switch
              aria-label={t.logins}
              checked={status.secrets.logins}
              onCheckedChange={(on) => void act(api.setLogins(on))}
            />
          </ControlRow>
          <ControlRow label={t.passwordRow}>
            <Button variant="outline" size="sm" onClick={() => setForm('change')}>
              {t.change}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming('remove')}>
              {t.remove}
            </Button>
          </ControlRow>
        </>
      ) : null}
      {shownForm === 'change' && state === 'unlocked' ? (
        <PasswordFields
          d={d}
          label={t.changeTitle}
          withConfirm
          submit={t.change}
          onSubmit={(f) => void act(api.changePassword(f.password, f.confirm))}
        />
      ) : null}
      {error ? <WarningNote>{error}</WarningNote> : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === 'remove' ? t.removeTitle : t.resetTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === 'remove' ? t.removeBody : t.resetBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                const which = confirming
                setConfirming(null)
                if (which === 'remove') void act(api.remove())
                else setForm('reset')
              }}
            >
              {confirming === 'remove' ? t.remove : t.reset}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={recoveryKey !== null}
        onOpenChange={(open) => {
          if (!open) setRecoveryKey(null)
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
            <AlertDialogAction size="sm" onClick={() => setRecoveryKey(null)}>
              {t.recoverySaved}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
