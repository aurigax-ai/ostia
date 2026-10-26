import type { Dict } from '@shared/app/dict'
import type { ServerStatus } from '@shared/server/serverApi'
import { useState } from 'react'
import { TextLink } from '@/components/common/TextLink'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { ServerAddressRow } from './ServerAddressRow'
import { ServerLeaveDialog } from './ServerLeaveDialog'
import { ServerSignInDialog } from './ServerSignInDialog'

const LINK = 'h-auto px-0'

function providerName(d: Dict, status: ServerStatus): string {
  return status.provider === 'github' ? d.server.providerGithub : d.server.providerInvite
}

export function SignedOutRows({ status }: { status: ServerStatus }): JSX.Element {
  const d = useDict()
  const [open, setOpen] = useState(false)
  return (
    <>
      <ControlRow
        label={d.server.accountLabel}
        desc={status.host ? fmt(d.server.signInDesc, { host: status.host }) : d.server.noServerDesc}
      >
        <Button size="sm" onClick={() => setOpen(true)}>
          {d.server.signIn}
        </Button>
      </ControlRow>
      <ServerSignInDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

export function SignedInRows({
  status,
  onChangePassphrase,
}: {
  status: ServerStatus
  onChangePassphrase: (() => void) | null
}): JSX.Element {
  const d = useDict()
  const [leaving, setLeaving] = useState(false)

  const signOut = async (): Promise<void> => {
    setLeaving(false)
    await window.ostia.server.signOut()
  }

  return (
    <>
      <ControlRow
        label={d.server.accountLabel}
        desc={fmt(d.server.signedInDesc, {
          device: status.deviceName ?? '',
          provider: providerName(d, status),
        })}
        below={
          onChangePassphrase ? (
            <TextLink size="sm" className={LINK} onClick={onChangePassphrase}>
              {d.server.changePassphrase}
            </TextLink>
          ) : null
        }
      >
        <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>
          {d.server.signOut}
        </Button>
      </ControlRow>
      <ServerAddressRow status={status} />
      <ServerLeaveDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        onConfirm={() => void signOut()}
      />
    </>
  )
}
