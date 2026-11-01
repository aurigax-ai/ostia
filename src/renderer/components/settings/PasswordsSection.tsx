import { CopyIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { CredentialImportResult, CredentialSummary } from '@shared/browser/credentials'
import { type FormEvent, type JSX, useCallback, useEffect, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { RowRemoveButton } from '@/components/settingsKit/RowRemoveButton'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
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
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/lib/app/useDict'

function importMessage(d: Dict, res: CredentialImportResult): string | null {
  if (res.ok)
    return fmt(d.passwords.imported, {
      n: res.imported,
      updated: res.updated,
      skipped: res.skipped,
    })
  if (res.error === 'cancelled') return null
  if (res.error === 'no-columns') return d.passwords.importNoColumns
  if (res.error === 'encryption-unavailable') return d.passwords.encryptionUnavailable
  return d.passwords.importUnreadable
}

function SavedPasswords({
  list,
  onStatus,
  onReload,
  onRemove,
}: {
  list: CredentialSummary[]
  onStatus: (status: string) => void
  onReload: () => void
  onRemove: (credential: CredentialSummary) => void
}): JSX.Element {
  const d = useDict()
  return (
    <SettingsGroup title={d.passwords.groupSaved}>
      <SettingsList label={d.passwords.groupSaved} empty={d.passwords.none}>
        {list.map((c) => (
          <SettingsListRow
            key={c.id}
            title={c.origin}
            detail={c.username || d.passwords.noUsername}
            actions={
              <>
                <IconButton
                  icon={CopyIcon}
                  label={fmt(d.passwords.copy, { origin: c.origin })}
                  onClick={() =>
                    void window.ostia.credentials
                      .copyPassword(c.id)
                      .then((ok) =>
                        onStatus(ok ? d.passwords.copied : d.passwords.encryptionUnavailable),
                      )
                  }
                />
                <RowRemoveButton
                  label={fmt(d.passwords.remove, { origin: c.origin })}
                  onClick={() => onRemove(c)}
                />
              </>
            }
          />
        ))}
      </SettingsList>
      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void window.ostia.credentials.import().then((res) => {
              const message = importMessage(d, res)
              if (message) onStatus(message)
              if (res.ok) onReload()
            })
          }
        >
          {d.passwords.import}
        </Button>
        <span className="text-fg-muted text-ui-xs">{d.passwords.importHint}</span>
      </div>
    </SettingsGroup>
  )
}

function AddPasswordForm({
  onStatus,
  onSaved,
}: {
  onStatus: (status: string) => void
  onSaved: () => void
}): JSX.Element {
  const d = useDict()
  const [origin, setOrigin] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const res = await window.ostia.credentials.save({ origin, username, password })
    if (res.ok) {
      setOrigin('')
      setUsername('')
      setPassword('')
      onStatus(res.updated ? d.passwords.updated : d.passwords.saved)
      onSaved()
    } else {
      onStatus(
        res.error === 'invalid-origin'
          ? d.passwords.invalidOrigin
          : res.error === 'empty'
            ? d.passwords.emptyPassword
            : d.passwords.encryptionUnavailable,
      )
    }
  }

  return (
    <SettingsGroup title={d.passwords.groupAdd}>
      <form
        className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-3"
        onSubmit={(e) => void add(e)}
      >
        <Label htmlFor="pw-origin" className="text-ui-sm">
          {d.passwords.site}
        </Label>
        <Input
          id="pw-origin"
          value={origin}
          placeholder="https://github.com"
          spellCheck={false}
          onChange={(e) => setOrigin(e.target.value)}
          className="h-7 text-ui-sm"
        />
        <Label htmlFor="pw-username" className="text-ui-sm">
          {d.passwords.username}
        </Label>
        <Input
          id="pw-username"
          value={username}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUsername(e.target.value)}
          className="h-7 text-ui-sm"
        />
        <Label htmlFor="pw-password" className="text-ui-sm">
          {d.passwords.password}
        </Label>
        <Input
          id="pw-password"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          className="h-7 text-ui-sm"
        />
        <div className="col-span-2 flex justify-end">
          <Button type="submit" size="sm" disabled={!origin || !password}>
            {d.passwords.save}
          </Button>
        </div>
      </form>
    </SettingsGroup>
  )
}

function RemovePasswordDialog({
  removing,
  onClose,
  onConfirm,
}: {
  removing: CredentialSummary | null
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <AlertDialog open={removing !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{d.passwords.removeTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {fmt(d.passwords.removeBody, {
              origin: removing?.origin ?? '',
              username: removing?.username || d.passwords.noUsername,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">{d.passwords.cancel}</AlertDialogCancel>
          <AlertDialogAction size="sm" variant="destructive" onClick={onConfirm}>
            {d.passwords.removeConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function PasswordsSection(): JSX.Element {
  const d = useDict()
  const [list, setList] = useState<CredentialSummary[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [removing, setRemoving] = useState<CredentialSummary | null>(null)

  const reload = useCallback(() => {
    void window.ostia.credentials.list().then(setList)
  }, [])
  useEffect(() => reload(), [reload])

  return (
    <SettingsPage title={d.passwords.title} desc={d.passwords.desc}>
      <SavedPasswords list={list} onStatus={setStatus} onReload={reload} onRemove={setRemoving} />
      <AddPasswordForm onStatus={setStatus} onSaved={reload} />
      {status ? <Notice tone="info">{status}</Notice> : null}
      <RemovePasswordDialog
        removing={removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing
          setRemoving(null)
          if (target) void window.ostia.credentials.remove(target.id).then(reload)
        }}
      />
    </SettingsPage>
  )
}
