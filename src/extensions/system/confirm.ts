import type { InstallPlan } from './install'
import type { Strings } from './strings'

const AUR_HELPERS = new Set(['yay', 'paru'])

export interface InstallConfirm {
  title: string
  message: string
  detail: string
  confirmLabel: string
  cancelLabel: string
  hostTerminal: string[]
}

export function installConfirm(plan: InstallPlan, s: Strings): InstallConfirm {
  const detail = s.confirmDetail(plan.command, plan.reason)
  return {
    title: s.confirmTitle,
    message: s.confirmMessage(plan.packages, plan.manager),
    detail: AUR_HELPERS.has(plan.manager) ? `${detail}\n\n${s.aurWarning}` : detail,
    confirmLabel: s.approve,
    cancelLabel: s.deny,
    hostTerminal: plan.argv,
  }
}
