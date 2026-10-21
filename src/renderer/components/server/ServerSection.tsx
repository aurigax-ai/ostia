import type { Dict } from '@shared/app/dict'
import type { ServerOffer, ServerStatus } from '@shared/server/serverApi'
import { useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { ServerAddressRow } from './ServerAddressRow'
import { ServerDevices } from './ServerDevices'
import { ServerLeaveDialog } from './ServerLeaveDialog'
import { ServerSignIn } from './ServerSignIn'
import { serverErrorText } from './serverText'
import { useServerDevices } from './useServerDevices'
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

function SignedInRow({
  status,
  onSignOut,
}: {
  status: ServerStatus
  onSignOut: () => void
}): JSX.Element {
  const d = useDict()

  return (
    <ControlRow
      label={d.server.signedInLabel}
      desc={`${fmt(d.server.signedInDesc, {
        device: status.deviceName ?? '',
        provider: providerName(d, status),
      })} ${d.server.signOutDesc}`}
    >
      <Button variant="outline" size="sm" onClick={onSignOut}>
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
  const devices = useServerDevices(status.signedIn)
  const [leaving, setLeaving] = useState(false)
  const [kept, setKept] = useState(false)

  const signOut = async (): Promise<void> => {
    const res = await window.ostia.server.signOut()
    setKept(res.ok && res.deviceKept)
  }

  return (
    <SettingsPage title={d.server.title}>
      <SettingsGroup title={d.server.accountLabel} desc={d.server.desc}>
        {kept && !status.signedIn ? <Notice tone="info">{d.server.leaveKept}</Notice> : null}
        <ServerAddressRow status={status} />
        {offered.state === 'error' ? <Notice>{serverErrorText(d, offered.error)}</Notice> : null}
        {offered.state === 'ready' ? (
          <ControlRow
            label={d.server.offerLabel}
            desc={names.length > 0 ? names.join(' · ') : d.server.offerNone}
          />
        ) : null}
        {status.signedIn ? (
          <SignedInRow status={status} onSignOut={() => setLeaving(true)} />
        ) : null}
        {!status.signedIn && offered.state === 'ready' ? (
          <ServerSignIn offer={offered.offer} />
        ) : null}
      </SettingsGroup>
      {status.signedIn ? (
        <SettingsGroup title={d.server.devicesLabel}>
          <ServerDevices state={devices} onLeave={() => setLeaving(true)} />
        </SettingsGroup>
      ) : null}
      <ServerLeaveDialog
        open={leaving}
        last={devices.loaded && devices.devices.length <= 1}
        onClose={() => setLeaving(false)}
        onConfirm={() => {
          setLeaving(false)
          void signOut()
        }}
      />
    </SettingsPage>
  )
}
