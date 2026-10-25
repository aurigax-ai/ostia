import type { Dict } from '@shared/app/dict'
import type { ServerStatus } from '@shared/server/serverApi'
import { useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { ServerAddressRow } from './ServerAddressRow'
import { GithubWaitLine, useGithubSignIn } from './ServerGithub'
import { ServerLeaveDialog } from './ServerLeaveDialog'
import { InviteRow } from './ServerSignIn'
import { serverErrorText } from './serverText'
import { useServerOffer } from './useServerStatus'

const LINK = 'h-auto px-0'

function providerName(d: Dict, status: ServerStatus): string {
  return status.provider === 'github' ? d.server.providerGithub : d.server.providerInvite
}

export function SignedOutRows({ status }: { status: ServerStatus }): JSX.Element {
  const d = useDict()
  const offered = useServerOffer(status.url)
  const github = useGithubSignIn()
  const [inviteShown, setInviteShown] = useState(false)
  const [addressShown, setAddressShown] = useState(false)
  const offer = offered.state === 'ready' ? offered.offer : null
  const withGithub = offer?.github === true
  const inviteRow = offer?.invite === true && (inviteShown || !withGithub)
  const links = [
    withGithub && offer?.invite && !inviteShown ? (
      <TextLink key="invite" size="sm" className={LINK} onClick={() => setInviteShown(true)}>
        {d.server.useInvite}
      </TextLink>
    ) : null,
    addressShown || status.url === null ? null : (
      <TextLink key="server" size="sm" className={LINK} onClick={() => setAddressShown(true)}>
        {d.server.changeServer}
      </TextLink>
    ),
  ].filter((link) => link !== null)
  return (
    <>
      <ControlRow
        label={d.server.accountLabel}
        desc={status.host ? fmt(d.server.signInDesc, { host: status.host }) : d.server.noServerDesc}
        error={github.error ? serverErrorText(d, github.error) : null}
        below={
          github.flow ? (
            <GithubWaitLine flow={github.flow} />
          ) : links.length > 0 ? (
            <span className="flex items-center gap-4">{links}</span>
          ) : null
        }
      >
        {withGithub && github.flow ? (
          <Button variant="outline" size="sm" onClick={github.cancel}>
            {d.server.cancel}
          </Button>
        ) : null}
        {withGithub && !github.flow ? (
          <Button size="sm" onClick={() => void github.start()}>
            {d.server.githubStart}
          </Button>
        ) : null}
      </ControlRow>
      {offered.state === 'error' ? <Notice>{serverErrorText(d, offered.error)}</Notice> : null}
      {inviteRow ? <InviteRow /> : null}
      {addressShown || status.url === null ? <ServerAddressRow status={status} /> : null}
    </>
  )
}

export function SignedInRows({
  status,
  onChangePassphrase,
  onLeft,
}: {
  status: ServerStatus
  onChangePassphrase: (() => void) | null
  onLeft: (kept: boolean) => void
}): JSX.Element {
  const d = useDict()
  const [leaving, setLeaving] = useState(false)

  const signOut = async (): Promise<void> => {
    setLeaving(false)
    const res = await window.ostia.server.signOut()
    onLeft(res.ok && res.deviceKept)
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
