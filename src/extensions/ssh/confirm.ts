import type { ConfirmRequest } from '../sdk'
import type { ConnectPlan } from './plan'
import type { Strings } from './strings'
import type { SshTarget } from './target'

function login(plan: ConnectPlan, target: SshTarget): string {
  const host = target.hostname ?? target.alias
  const port = plan.port ?? target.port
  const address = port === undefined ? host : `${host}:${port}`
  return target.user ? `${target.user}@${address}` : address
}

function route(plan: ConnectPlan, target: SshTarget, s: Strings): string | null {
  const hops = plan.jump.length > 0 ? plan.jump : target.jump
  if (hops.length > 0) return hops.join(', ')
  return target.proxyCommand ? s.proxyCommand : null
}

export function connectConfirm(plan: ConnectPlan, target: SshTarget, s: Strings): ConfirmRequest {
  const through = route(plan, target, s)
  const lines = [s.commandLabel, plan.command, '', `${s.targetLabel} ${login(plan, target)}`]
  if (through) lines.push(`${s.throughLabel} ${through}`)
  if (plan.shellIntegration) lines.push('', s.integrationNote)
  lines.push('', s.confirmNote)
  return {
    title: s.confirmTitle,
    message: s.confirmMessage(plan.destination),
    detail: lines.join('\n'),
    confirmLabel: s.approve,
    cancelLabel: s.deny,
  }
}
