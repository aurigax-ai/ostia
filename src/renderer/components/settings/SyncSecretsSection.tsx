import type { SecretActionResult, SyncStatus } from '@shared/profileSync/profileSync'
import { type JSX, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { ToggleRow } from '@/components/settingsKit/ControlRow'
import { useDict } from '@/lib/app/useDict'
import { SecretFormDialog } from './SecretFormDialog'
import { type SecretPasswordStep, secretErrorText, secretPasswordStep } from './secretPasswordSteps'

const LINK = 'h-auto px-0'

export function SyncSecretsSection({
  status,
  server,
  onStatus,
}: {
  status: SyncStatus
  server: boolean
  onStatus: (status: SyncStatus) => void
}): JSX.Element {
  const d = useDict()
  const t = d.sync.secrets
  const api = window.ostia.sync.secrets
  const { state, mode } = status.secrets
  const [step, setStep] = useState<SecretPasswordStep | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (work: Promise<SecretActionResult>): Promise<SyncStatus> => {
    const res = await work
    onStatus(res.status)
    setError(res.ok ? null : secretErrorText(d, res.error))
    return res.status
  }

  const turn = async (on: boolean): Promise<void> => {
    if (!on) {
      await act(api.disable())
      return
    }
    const next = (await act(api.enable())).secrets.state
    if (next === 'needs-setup') setStep('create')
    if (next === 'locked') setStep('enter')
  }

  const link = (label: string, onClick: () => void): JSX.Element => (
    <TextLink key={label} size="sm" className={LINK} onClick={onClick}>
      {label}
    </TextLink>
  )

  const links = (): JSX.Element[] => {
    if (state === 'locked') return [link(t.enterPassword, () => setStep('enter'))]
    if (state === 'needs-setup') return [link(t.setPassword, () => setStep('create'))]
    if (state !== 'unlocked') return []
    if (mode === 'sync-key') {
      return server ? [link(t.useSeparate, () => setStep('separate'))] : []
    }
    return [
      link(t.change, () => setStep('change')),
      ...(server ? [link(t.useSyncKey, () => void act(api.useSyncKey()))] : []),
    ]
  }

  const shown = links()
  return (
    <>
      <ToggleRow
        label={t.toggle}
        desc={mode === 'sync-key' ? t.toggleDescSyncKey : t.toggleDescPassword}
        checked={state !== 'off'}
        onChange={(on) => void turn(on)}
        below={shown.length > 0 ? <span className="flex items-center gap-4">{shown}</span> : null}
      />
      <ToggleRow
        label={t.logins}
        desc={t.loginsDesc}
        checked={status.secrets.logins}
        disabled={state === 'off'}
        onChange={(on) => void act(api.setLogins(on))}
      />
      {state === 'damaged' ? (
        <Notice tone="error" actions={link(t.reset, () => setStep('reset'))}>
          {t.damaged}
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <SecretFormDialog
        step={
          step ? secretPasswordStep(step, { d, onStatus, show: (next) => setStep(next) }) : null
        }
        recovery={{ title: t.recoveryTitle, desc: t.recoveryBody }}
        onClose={() => setStep(null)}
      />
    </>
  )
}
