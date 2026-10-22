import type {
  ServerSyncResult,
  ServerSyncStatus,
  WrapRefusal,
} from '@shared/profileSync/serverSync'
import type { ServerStatus } from '@shared/server/serverApi'
import { useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { Notice } from '@/components/common/Notice'
import { syncServerErrorText } from '@/components/server/syncServerText'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
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

function WrapRefusedNotice({ refusal }: { refusal: WrapRefusal }): JSX.Element {
  const t = useDict().syncServer
  const locale = useSettingsStore((s) => s.locale)
  if (refusal.reason === 'too-new' && refusal.after !== null) {
    return <Notice>{fmt(t.wrapRefusedTooNew, { time: formatDate(refusal.after, locale) })}</Notice>
  }
  if (refusal.reason === 'unverified') return <Notice>{t.wrapRefusedUnverified}</Notice>
  return <Notice tone="error">{t.wrapRefusedUntrusted}</Notice>
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
      {status.linkApproved ? (
        <Notice
          actions={status.linkCodes.map((link) => (
            <Button
              key={link.code}
              variant="outline"
              size="sm"
              onClick={() => void act(api.linkConfirm(link.code))}
            >
              {fmt(t.linkConfirm, { code: link.code })}
            </Button>
          ))}
        >
          {t.linkApproved}
        </Notice>
      ) : null}
    </>
  )
}

function Ready({ status, act }: StateProps): JSX.Element {
  const t = useDict().syncServer
  const api = window.ostia.syncServer
  return (
    <>
      {status.wrapRefused?.reason === 'too-new' ? (
        <PassphraseForm
          label={t.unlockTitle}
          placeholder={t.passphrase}
          submit={t.unlock}
          onSubmit={(passphrase) => void act(api.unlock(passphrase))}
        />
      ) : null}
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
    </>
  )
}

export function SyncServerSection({
  account,
  status,
  setStatus,
  onChanged,
}: {
  account: ServerStatus
  status: ServerSyncStatus
  setStatus: (status: ServerSyncStatus) => void
  onChanged: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.syncServer
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
      <ControlRow label={t.whereServer} desc={t.notSignedIn}>
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
      {status.state === 'untrusted' ? <Notice tone="error">{t.untrusted}</Notice> : null}
      {status.wrapRefused ? <WrapRefusedNotice refusal={status.wrapRefused} /> : null}
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
      <RecoveryKeyDialog recoveryKey={recoveryKey} onClose={() => setRecoveryKey(null)} />
    </>
  )
}
