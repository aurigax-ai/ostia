import type { Dict } from '@shared/app/dict'
import type { ServerOffer, ServerStatus } from '@shared/server/serverApi'
import { useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { ServerAddressRow } from './ServerAddressRow'
import { ServerDevices } from './ServerDevices'
import { ServerSignIn } from './ServerSignIn'
import { serverErrorText } from './serverText'
import { useServerOffer, useServerStatus } from './useServerStatus'

function offerNames(d: Dict, offer: ServerOffer): string[] {
  return [
    offer.relay ? d.server.offerRelay : null,
    offer.publish ? d.server.offerPublish : null,
    offer.sync ? d.server.offerSync : null,
    offer.push ? d.server.offerPush : null,
  ].filter((name): name is string => name !== null)
}

function providerName(d: Dict, status: ServerStatus): string {
  return status.provider === 'github' ? d.server.providerGithub : d.server.providerInvite
}

function SignedInRow({ status }: { status: ServerStatus }): JSX.Element {
  const d = useDict()
  const [busy, setBusy] = useState(false)

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.ostia.server.signOut()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ControlRow
      label={d.server.signedInLabel}
      desc={fmt(d.server.signedInDesc, {
        device: status.deviceName ?? '',
        host: status.host ?? '',
        provider: providerName(d, status),
      })}
      below={<span className="text-fg-muted text-ui-sm">{d.server.signOutDesc}</span>}
    >
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}>
        {d.server.signOut}
      </Button>
    </ControlRow>
  )
}

export function ServerSection(): JSX.Element {
  const d = useDict()
  const status = useServerStatus()
  const offered = useServerOffer(status.url)
  const names = offered.state === 'ready' ? offerNames(d, offered.offer) : []

  return (
    <SettingsPage title={d.server.title} desc={d.server.desc}>
      <ServerAddressRow status={status} />
      {offered.state === 'error' ? <Notice>{serverErrorText(d, offered.error)}</Notice> : null}
      {offered.state === 'ready' ? (
        <ControlRow
          label={d.server.offerLabel}
          desc={names.length > 0 ? names.join(' · ') : d.server.offerNone}
        />
      ) : null}
      {status.signedIn ? <SignedInRow status={status} /> : null}
      {status.signedIn ? <ServerDevices /> : null}
      {!status.signedIn && offered.state === 'ready' ? (
        <ServerSignIn offer={offered.offer} />
      ) : null}
    </SettingsPage>
  )
}
