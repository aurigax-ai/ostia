import { IconButton } from '@/components/common/IconButton'
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
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/i18n/useDict'
import { CopyIcon, TrashIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { CredentialImportResult, CredentialSummary } from '@shared/browser/credentials'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { SectionHead, SettingsGroup } from './SettingsPanel'

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

export function PasswordsSection(): JSX.Element {
  const d = useDict()
  const [list, setList] = useState<CredentialSummary[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [removing, setRemoving] = useState<CredentialSummary | null>(null)

  const reload = useCallback(() => {
    void window.ostia.credentials.list().then(setList)
  }, [])
  useEffect(() => reload(), [reload])

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const res = await window.ostia.credentials.save({ origin, username, password })
    if (res.ok) {
      setOrigin('')
      setUsername('')
      setPassword('')
      setStatus(res.updated ? d.passwords.updated : d.passwords.saved)
      reload()
    } else {
      setStatus(
        res.error === 'invalid-origin'
          ? d.passwords.invalidOrigin
          : res.error === 'empty'
            ? d.passwords.emptyPassword
            : d.passwords.encryptionUnavailable,
      )
    }
  }

  return (
    <div>
      <SectionHead title={d.passwords.title} desc={d.passwords.desc} />
      <SettingsGroup title={d.passwords.groupSaved}>
        {list.length === 0 ? (
          <p className="px-3 py-2 text-fg-muted text-ui-sm">{d.passwords.none}</p>
        ) : (
          <ul className="flex flex-col">
            {list.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-sm px-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg text-ui-base">{c.origin}</div>
                  <div className="truncate text-fg-muted text-ui-sm">
                    {c.username || d.passwords.noUsername}
                  </div>
                </div>
                <IconButton
                  icon={CopyIcon}
                  label={fmt(d.passwords.copy, { origin: c.origin })}
                  onClick={() =>
                    void window.ostia.credentials
                      .copyPassword(c.id)
                      .then((ok) =>
                        setStatus(ok ? d.passwords.copied : d.passwords.encryptionUnavailable),
                      )
                  }
                />
                <IconButton
                  icon={TrashIcon}
                  label={fmt(d.passwords.remove, { origin: c.origin })}
                  className="hover:text-attn-fg"
                  onClick={() => setRemoving(c)}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 px-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void window.ostia.credentials.import().then((res) => {
                const message = importMessage(d, res)
                if (message) setStatus(message)
                if (res.ok) reload()
              })
            }
          >
            {d.passwords.import}
          </Button>
          <span className="text-fg-muted text-ui-xs">{d.passwords.importHint}</span>
        </div>
      </SettingsGroup>
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
      {status ? (
        <output className="mt-2 block px-3 text-fg-muted text-ui-sm">{status}</output>
      ) : null}
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{d.passwords.removeTitle}</DialogTitle>
            <DialogDescription>
              {fmt(d.passwords.removeBody, {
                origin: removing?.origin ?? '',
                username: removing?.username || d.passwords.noUsername,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
              {d.passwords.cancel}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const target = removing
                setRemoving(null)
                if (target) void window.ostia.credentials.remove(target.id).then(reload)
              }}
            >
              {d.passwords.removeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
