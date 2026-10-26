import type { Dict } from '@shared/app/dict'
import type { SecretActionResult, SyncStatus } from '@shared/profileSync/profileSync'
import type { SecretOutcome, SecretStep } from './SecretFormDialog'

export type SecretPasswordStep = 'create' | 'separate' | 'reset' | 'enter' | 'recover' | 'change'

interface StepDeps {
  d: Dict
  onStatus: (status: SyncStatus) => void
  show: (step: SecretPasswordStep) => void
}

export function secretErrorText(d: Dict, error: string | undefined): string {
  const t = d.sync.secrets.errors
  switch (error) {
    case 'too-short':
      return t.tooShort
    case 'mismatch':
      return t.mismatch
    case 'wrong-password':
      return t.wrongPassword
    case 'wrong-recovery-key':
      return t.wrongRecoveryKey
    case 'exists':
      return t.exists
    case 'damaged':
      return t.damaged
    case 'no-bundle':
      return t.noBundle
    default:
      return t.failed
  }
}

export function secretPasswordStep(
  step: SecretPasswordStep,
  { d, onStatus, show }: StepDeps,
): SecretStep {
  const t = d.sync.secrets
  const api = window.ostia.sync.secrets
  const act = async (work: Promise<SecretActionResult>): Promise<SecretOutcome> => {
    const res = await work
    onStatus(res.status)
    return {
      ok: res.ok,
      ...(res.ok ? {} : { error: secretErrorText(d, res.error) }),
      ...(res.recoveryKey ? { recoveryKey: res.recoveryKey } : {}),
    }
  }
  const password = {
    name: 'password',
    label: t.newPassword,
    secret: true,
    autoComplete: 'new-password',
  }
  const again = {
    name: 'confirm',
    label: t.confirmPassword,
    secret: true,
    autoComplete: 'new-password',
  }
  const newPassword = (title: string, desc: string, run: typeof api.setup): SecretStep => ({
    title,
    desc,
    fields: [password, again],
    submit: t.continue,
    onSubmit: (v) => act(run(v.password ?? '', v.confirm ?? '')),
  })
  if (step === 'create') return newPassword(t.setupTitle, t.setupDesc, api.setup)
  if (step === 'separate') return newPassword(t.separateTitle, t.separateDesc, api.reset)
  if (step === 'reset') return newPassword(t.resetTitle, t.resetBody, api.reset)
  if (step === 'change') return newPassword(t.changeTitle, t.changeDesc, api.changePassword)
  if (step === 'enter') {
    return {
      title: t.unlockTitle,
      desc: t.locked,
      fields: [{ ...password, label: t.password, autoComplete: 'current-password' }],
      submit: t.continue,
      later: true,
      link: { label: t.useRecoveryKey, onClick: () => show('recover') },
      onSubmit: (v) => act(api.unlock(v.password ?? '')),
    }
  }
  return {
    title: t.recoverTitle,
    desc: t.recoverDesc,
    fields: [
      { name: 'key', label: t.recoveryKey, secret: false, autoComplete: 'off' },
      password,
      again,
    ],
    submit: t.continue,
    later: true,
    onSubmit: (v) => act(api.recover(v.key ?? '', v.password ?? '', v.confirm ?? '')),
  }
}
