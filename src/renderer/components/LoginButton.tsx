import { FloppyDiskIcon, KeyIcon, UserIcon } from '@phosphor-icons/react'
import type { CredentialSummary } from '@shared/credentials'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'

export function LoginButton({
  paneId,
  pageKey,
  onStatus,
}: {
  paneId: string
  pageKey: number
  onStatus: (message: string) => void
}): JSX.Element {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const [logins, setLogins] = useState<CredentialSummary[]>([])

  useEffect(() => {
    if (pageKey < 0) return
    let alive = true
    void window.ostia.credentials.forPage(paneId).then((list) => {
      if (alive) setLogins(list)
    })
    return () => {
      alive = false
    }
  }, [paneId, pageKey])

  const fill = async (login: CredentialSummary): Promise<void> => {
    setOpen(false)
    const res = await window.ostia.credentials.fill(paneId, login.id)
    onStatus(
      res.ok
        ? fmt(d.passwords.filled, { user: login.username || d.passwords.noUsername })
        : res.error === 'no-form'
          ? d.passwords.noForm
          : d.passwords.fillFailed,
    )
  }

  const saveFromPage = async (): Promise<void> => {
    setOpen(false)
    const res = await window.ostia.credentials.saveFromPage(paneId)
    if (res.ok) {
      onStatus(res.updated ? d.passwords.updated : d.passwords.saved)
      setLogins(await window.ostia.credentials.forPage(paneId))
    } else {
      onStatus(
        res.error === 'encryption-unavailable'
          ? d.passwords.encryptionUnavailable
          : d.passwords.nothingToSave,
      )
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="agent-session">
        <PopoverTrigger
          render={
            <IconButton
              icon={KeyIcon}
              label={
                logins.length > 0
                  ? fmt(d.passwords.available, { n: logins.length })
                  : d.passwords.title
              }
            />
          }
        />
        {logins.length > 0 ? <span className="dot agent-session-dot done" aria-hidden /> : null}
      </span>
      <PopoverContent align="end" className="w-72 gap-1 p-1.5">
        {logins.length === 0 ? (
          <p className="px-2 py-1.5 text-fg-muted text-ui-sm">{d.passwords.noneForSite}</p>
        ) : (
          logins.map((login) => (
            <Button
              key={login.id}
              variant="ghost"
              size="sm"
              className="h-7 justify-start gap-2 px-2 font-normal text-ui-base"
              onClick={() => void fill(login)}
            >
              <UserIcon data-icon="inline-start" aria-hidden className="text-fg-muted" />
              <span className="truncate">{login.username || d.passwords.noUsername}</span>
            </Button>
          ))
        )}
        <Separator className="-mx-1.5 my-1 w-auto" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start gap-2 px-2 font-normal text-ui-base"
          onClick={() => void saveFromPage()}
        >
          <FloppyDiskIcon data-icon="inline-start" aria-hidden className="text-fg-muted" />
          {d.passwords.saveFromPage}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
