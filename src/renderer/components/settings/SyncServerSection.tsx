import type { ServerSyncResult, ServerSyncStatus } from '@shared/profileSync/serverSync'
import { useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { Notice } from '@/components/common/Notice'
import { ServerDevices } from '@/components/server/ServerDevices'
import { syncServerErrorText } from '@/components/server/syncServerText'
import { useElevated } from '@/components/server/useElevated'
import { useServerStatus } from '@/components/server/useServerStatus'
import { useSyncServerStatus } from '@/components/server/useSyncServerStatus'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useUIStore } from '@/stores/app/uiStore'
import { PassphraseForm, RecoveryKeyDialog, RecoveryKeyForm } from './SyncServerForms'

function LinkCodes({ status }: { status: ServerSyncStatus }): JSX.Element | null {
  const t = useDict().syncServer
  if (!status.linking) return null
  return (
    <div className="flex flex-col gap-1 py-1">
      <output className="text-fg-muted text-ui-sm">{t.linkWaiting}</output>
      {status.linkCodes.map((link) => (
        <MachineValue
          key={link.code}
          value={fmt(t.linkCodeFor, { device: link.deviceName, code: link.code })}
        />
      ))}
    </div>
  )
}

interface StateProps {
  status: ServerSyncStatus
  act: (work: Promise<ServerSyncResult>) => Promise<void>
}

function Locked({ status, act }: StateProps): JSX.Element {
  const t = useDict().syncServer
  const api = window.ostia.syncServer
  return (
    <>
      <ControlRow label={t.unlockTitle} desc={t.unlockDesc} />
      <PassphraseForm
        label={t.unlockTitle}
        placeholder={t.passphrase}
        submit={t.unlock}
        onSubmit={(passphrase) => void act(api.unlock(passphrase))}
      />
      <RecoveryKeyForm onSubmit={(key) => void act(api.recover(key))} />
      <ControlRow label={t.linkByApproval}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void act(status.linking ? api.linkStop() : api.linkStart())}
        >
          {status.linking ? t.linkStop : t.linkByApproval}
        </Button>
      </ControlRow>
      <LinkCodes status={status} />
    </>
  )
}

function Ready({ status, act }: StateProps): JSX.Element {
  const t = useDict().syncServer
  const api = window.ostia.syncServer
  const elevated = useElevated()
  const [cleaned, setCleaned] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const d = useDict()

  const cleanUp = async (): Promise<void> => {
    setError(null)
    const res = await elevated.run(() => api.collectGarbage())
    if (res.ok) setCleaned(res.deleted ?? 0)
    else setError(syncServerErrorText(d, res.error))
  }

  return (
    <>
      <output className="block py-1 text-fg-muted text-ui-sm">{t.ready}</output>
      {status.recoveryStale ? (
        <Notice
          actions={
            <Button variant="outline" size="sm" onClick={() => void act(api.newRecoveryKey())}>
              {t.recoveryNew}
            </Button>
          }
        >
          {t.recoveryStale}
        </Notice>
      ) : null}
      <ControlRow
        label={t.cleanUp}
        desc={t.cleanUpDesc}
        error={error}
        below={
          cleaned !== null ? (
            <output className="text-fg-muted text-ui-sm">
              {fmt(t.cleanedUp, { count: String(cleaned) })}
            </output>
          ) : null
        }
      >
        <Button variant="outline" size="sm" onClick={() => void cleanUp()}>
          {t.cleanUpRun}
        </Button>
      </ControlRow>
      {elevated.prompt}
    </>
  )
}

export function SyncServerSection({ onChanged }: { onChanged: () => void }): JSX.Element {
  const d = useDict()
  const t = d.syncServer
  const account = useServerStatus()
  const [status, setStatus] = useSyncServerStatus(account.signedIn)
  const [error, setError] = useState<string | null>(null)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const api = window.ostia.syncServer

  const act = async (work: Promise<ServerSyncResult>): Promise<void> => {
    const res = await work
    setStatus(res.status)
    setError(res.ok ? null : syncServerErrorText(d, res.error))
    if (res.recoveryKey) setRecoveryKey(res.recoveryKey)
    if (res.ok) onChanged()
  }

  if (!account.signedIn) {
    return (
      <ControlRow label={t.where} desc={t.notSignedIn}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => useUIStore.getState().openSettings('server')}
        >
          {t.openServer}
        </Button>
      </ControlRow>
    )
  }
  return (
    <>
      {status.state === 'unsupported' ? <Notice>{t.unsupported}</Notice> : null}
      {status.state === 'unreachable' ? <Notice>{t.unreachable}</Notice> : null}
      {status.state === 'needs-setup' ? (
        <>
          <ControlRow label={t.setupTitle} desc={t.setupDesc} />
          <PassphraseForm
            label={t.setupTitle}
            placeholder={t.newPassphrase}
            confirmPlaceholder={t.confirmPassphrase}
            submit={t.setup}
            onSubmit={(passphrase, confirm) => void act(api.setup(passphrase, confirm))}
          />
        </>
      ) : null}
      {status.state === 'locked' ? <Locked status={status} act={act} /> : null}
      {status.state === 'ready' ? <Ready status={status} act={act} /> : null}
      {error ? <Notice>{error}</Notice> : null}
      <ServerDevices />
      <RecoveryKeyDialog recoveryKey={recoveryKey} onClose={() => setRecoveryKey(null)} />
    </>
  )
}
