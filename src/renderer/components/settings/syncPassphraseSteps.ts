import type { Dict } from '@shared/app/dict'
import type { ServerSyncResult, ServerSyncStatus } from '@shared/profileSync/serverSync'
import { syncServerErrorText } from '@/components/server/syncServerText'
import type { SecretOutcome, SecretStep } from './SecretFormDialog'

export type PassphraseStep = 'create' | 'enter' | 'recover' | 'change'

interface StepDeps {
  d: Dict
  onStatus: (status: ServerSyncStatus) => void
  show: (step: PassphraseStep) => void
}

function outcomeOf(d: Dict, res: ServerSyncResult): SecretOutcome {
  return {
    ok: res.ok,
    ...(res.ok ? {} : { error: syncServerErrorText(d, res.error) }),
    ...(res.recoveryKey ? { recoveryKey: res.recoveryKey } : {}),
  }
}

export function passphraseStep(step: PassphraseStep, { d, onStatus, show }: StepDeps): SecretStep {
  const t = d.syncServer
  const api = window.ostia.syncServer
  const act = async (work: Promise<ServerSyncResult>): Promise<SecretOutcome> => {
    const res = await work
    onStatus(res.status)
    return outcomeOf(d, res)
  }
  const passphrase = { name: 'passphrase', label: t.passphrase, secret: true }
  const again = { name: 'confirm', label: t.confirmPassphrase, secret: true }
  if (step === 'create') {
    return {
      title: t.createTitle,
      desc: t.createDesc,
      fields: [
        { ...passphrase, autoComplete: 'new-password' },
        { ...again, autoComplete: 'new-password' },
      ],
      submit: t.continue,
      later: true,
      onSubmit: (v) => act(api.setup(v.passphrase ?? '', v.confirm ?? '')),
    }
  }
  if (step === 'enter') {
    return {
      title: t.enterTitle,
      desc: t.enterDesc,
      fields: [{ ...passphrase, autoComplete: 'current-password' }],
      submit: t.continue,
      later: true,
      link: { label: t.useRecoveryKey, onClick: () => show('recover') },
      onSubmit: (v) => act(api.unlock(v.passphrase ?? '')),
    }
  }
  if (step === 'recover') {
    return {
      title: t.recoverTitle,
      desc: t.recoverDesc,
      fields: [
        { name: 'key', label: t.recoveryKey, secret: false, autoComplete: 'off' },
        { ...passphrase, label: t.newPassphrase, autoComplete: 'new-password' },
        { ...again, autoComplete: 'new-password' },
      ],
      submit: t.continue,
      later: true,
      link: { label: t.usePassphrase, onClick: () => show('enter') },
      onSubmit: (v) => act(api.recover(v.key ?? '', v.passphrase ?? '', v.confirm ?? '')),
    }
  }
  return {
    title: t.changeTitle,
    desc: t.changeDesc,
    fields: [
      {
        name: 'current',
        label: t.currentPassphrase,
        secret: true,
        autoComplete: 'current-password',
      },
      { name: 'next', label: t.newPassphrase, secret: true, autoComplete: 'new-password' },
      { ...again, autoComplete: 'new-password' },
    ],
    submit: t.changeConfirm,
    onSubmit: (v) => act(api.changePassphrase(v.current ?? '', v.next ?? '', v.confirm ?? '')),
  }
}
