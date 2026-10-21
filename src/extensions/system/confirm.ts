import type { Translate } from '@aurigax-ai/ostia-extension-sdk'
import type { InstallPlan } from './install'

const AUR_HELPERS = new Set(['yay', 'paru'])

export interface InstallConfirm {
  title: string
  message: string
  detail: string
  confirmLabel: string
  cancelLabel: string
  hostTerminal: string[]
}

export function installConfirm(plan: InstallPlan, t: Translate): InstallConfirm {
  const detail = t('confirmDetail', {
    command: plan.command,
    reason: plan.reason ?? t('noReason'),
  })
  return {
    title: t('confirmTitle'),
    message: t('confirmMessage', {
      packages: plan.packages.join(t('listSeparator')),
      manager: plan.manager,
    }),
    detail: AUR_HELPERS.has(plan.manager) ? `${detail}\n\n${t('aurWarning')}` : detail,
    confirmLabel: t('approve'),
    cancelLabel: t('deny'),
    hostTerminal: plan.argv,
  }
}
