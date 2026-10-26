import type { Dict } from '@shared/app/dict'
import type { SyncStatus } from '@shared/profileSync/profileSync'
import type { ServerSyncStatus } from '@shared/profileSync/serverSync'
import { useEffect, useMemo, useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { Notice } from '@/components/common/Notice'
import { SignedInRows, SignedOutRows } from '@/components/server/SyncAccountRows'
import { syncServerStatusError } from '@/components/server/syncServerText'
import { useServerStatus } from '@/components/server/useServerStatus'
import { useSyncServerStatus } from '@/components/server/useSyncServerStatus'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { StatusText } from '@/components/settingsKit/StatusText'
import { Button } from '@/components/ui/button'
import { SHORT_DATE_TIME } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { SecretFormDialog } from './SecretFormDialog'
import { SyncSecretsSection } from './SyncSecretsSection'
import { type PassphraseStep, passphraseStep } from './syncPassphraseSteps'

type Method = 'off' | 'folder' | 'server'

const OFF: SyncStatus = {
  dir: null,
  state: 'off',
  lastSync: null,
  skipped: [],
  heldBack: [],
  secrets: { state: 'off', mode: 'password', logins: false },
}

function syncErrorText(d: Dict, error: string | undefined): string {
  const server = syncServerStatusError(d, error)
  if (server) return server
  if (error === 'missing') return d.sync.errMissing
  if (error === 'not-a-directory') return d.sync.errNotDir
  if (error === 'same-as-local') return d.sync.errSame
  if (error === 'unreachable') return d.sync.errUnreachable
  if (error === 'scan-failed') return d.sync.errScan
  if (error === 'busy') return d.sync.errBusy
  if (error?.startsWith('invalid-json:')) {
    return fmt(d.sync.errInvalid, { files: error.slice('invalid-json:'.length) })
  }
  return fmt(d.sync.errUnknown, { error: error ?? '' })
}

function neededStep(server: ServerSyncStatus): PassphraseStep | null {
  if (server.state === 'needs-setup') return 'create'
  return server.state === 'locked' ? 'enter' : null
}

function serverProblem(d: Dict, server: ServerSyncStatus): string | null {
  if (server.state === 'unsupported') return d.syncServer.unsupported
  return server.state === 'unreachable' ? d.syncServer.unreachable : null
}

function useSyncStatus(): [SyncStatus, (status: SyncStatus) => void] {
  const [status, setStatus] = useState<SyncStatus>(OFF)
  useEffect(() => {
    let live = true
    void window.ostia.sync.status().then((s) => {
      if (live) setStatus(s)
    })
    const off = window.ostia.sync.onStatus((s) => setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return [status, setStatus]
}

function usePassphrasePrompt(
  needed: PassphraseStep | null,
): [PassphraseStep | null, (step: PassphraseStep | null) => void] {
  const [step, setStep] = useState<PassphraseStep | null>(null)
  const [prompted, setPrompted] = useState<PassphraseStep | null>(null)
  useEffect(() => {
    if (needed === prompted) return
    setPrompted(needed)
    if (needed) setStep(needed)
  }, [needed, prompted])
  return [step, setStep]
}

export function SyncSection(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const dir = useSettingsStore((s) => s.sync?.dir ?? '')
  const chosen = useSettingsStore((s) => s.sync?.method ?? 'folder')
  const setSyncDir = useSettingsStore((s) => s.setSyncDir)
  const setSyncMethod = useSettingsStore((s) => s.setSyncMethod)
  const method: Method = chosen === 'server' ? 'server' : dir ? 'folder' : 'off'
  const server = method === 'server'
  const account = useServerStatus()
  const accountShown = server || account.signedIn
  const [status, setStatus] = useSyncStatus()
  const [serverStatus, setServerStatus] = useSyncServerStatus(server && account.signedIn)
  const ready = !server || serverStatus.state === 'ready'
  const needed = server && account.signedIn ? neededStep(serverStatus) : null
  const [step, setStep] = usePassphrasePrompt(needed)
  const [busy, setBusy] = useState(false)
  const time = useMemo(() => new Intl.DateTimeFormat(locale, SHORT_DATE_TIME), [locale])
  const active = method === 'folder' || (server && account.signedIn)

  const syncNow = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.ostia.sync.run())
    } finally {
      setBusy(false)
    }
  }

  const pickMethod = async (next: Method): Promise<void> => {
    if (next === 'off') {
      await setSyncMethod('folder')
      await setSyncDir('')
      setStatus(OFF)
      return
    }
    if (next === 'server') {
      await setSyncMethod('server')
      await syncNow()
      return
    }
    const picked = await window.ostia.sync.pickFolder()
    if (!picked) return
    await setSyncMethod('folder')
    await setSyncDir(picked)
    await syncNow()
  }

  const chooseFolder = async (): Promise<void> => {
    const picked = await window.ostia.sync.pickFolder()
    if (!picked) return
    await setSyncDir(picked)
    await syncNow()
  }

  const problem = server ? serverProblem(d, serverStatus) : null
  const failed = ready && status.state === 'error'
  const statusText = needed
    ? d.syncServer.waiting
    : failed
      ? syncErrorText(d, status.error)
      : status.lastSync
        ? fmt(d.sync.lastSync, { time: time.format(new Date(status.lastSync)) })
        : d.sync.never

  return (
    <SettingsPage title={d.sync.title} desc={d.sync.desc}>
      <ControlRow label={d.sync.method} desc={method === 'off' ? d.sync.methodDesc : undefined}>
        <SelectField<Method>
          label={d.sync.method}
          value={method}
          options={[
            { value: 'off', label: d.sync.off },
            { value: 'folder', label: d.sync.methodFolder },
            { value: 'server', label: d.sync.methodServer },
          ]}
          onChange={(next) => void pickMethod(next)}
          width="w-48"
        />
      </ControlRow>
      {active ? (
        <ControlRow
          label={d.sync.status}
          error={problem ?? (failed ? statusText : null)}
          below={problem || failed ? null : <StatusText text={statusText} ok={!needed} />}
        >
          {needed ? (
            <Button variant="outline" size="sm" onClick={() => setStep(needed)}>
              {needed === 'create' ? d.syncServer.createButton : d.syncServer.enterButton}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !ready}
              onClick={() => void syncNow()}
            >
              {d.sync.now}
            </Button>
          )}
        </ControlRow>
      ) : null}
      {method === 'folder' ? (
        <ControlRow label={d.sync.folder} desc={d.sync.folderDesc}>
          <MachineValue value={dir} />
          <Button variant="outline" size="sm" onClick={() => void chooseFolder()}>
            {d.sync.change}
          </Button>
        </ControlRow>
      ) : null}
      {accountShown && account.signedIn ? (
        <SignedInRows
          status={account}
          onChangePassphrase={serverStatus.state === 'ready' ? () => setStep('change') : null}
        />
      ) : null}
      {accountShown && !account.signedIn ? <SignedOutRows status={account} /> : null}
      {active && status.skipped.length > 0 ? (
        <Notice>{fmt(d.sync.skipped, { files: status.skipped.join(', ') })}</Notice>
      ) : null}
      {active && status.heldBack.length > 0 ? (
        <Notice>{fmt(d.sync.heldBack, { keys: status.heldBack.join(', ') })}</Notice>
      ) : null}
      {active && ready ? (
        <SyncSecretsSection status={status} server={server} onStatus={setStatus} />
      ) : null}
      <SecretFormDialog
        step={
          step
            ? passphraseStep(step, {
                d,
                onStatus: setServerStatus,
                show: (next) => setStep(next),
              })
            : null
        }
        recovery={{ title: d.syncServer.recoveryTitle, desc: d.syncServer.recoveryBody }}
        onClose={() => setStep(null)}
      />
    </SettingsPage>
  )
}
