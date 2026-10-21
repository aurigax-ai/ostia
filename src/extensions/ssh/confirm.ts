import type { ConfirmRequest, Translate } from '@aurigax-ai/ostia-extension-sdk'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import type { ConnectPlan } from './plan'
import type { SshTarget } from './target'

function login(plan: ConnectPlan, target: SshTarget): string {
  const host = target.hostname ?? target.alias
  const port = plan.port ?? target.port
  const address = port === undefined ? host : `${host}:${port}`
  return target.user ? `${target.user}@${address}` : address
}

function route(plan: ConnectPlan, target: SshTarget, t: Translate): string | null {
  const hops = plan.jump.length > 0 ? plan.jump : target.jump
  if (hops.length > 0) return hops.join(', ')
  return target.proxyCommand ? t('proxyCommand') : null
}

export function connectConfirm(plan: ConnectPlan, target: SshTarget, t: Translate): ConfirmRequest {
  const through = route(plan, target, t)
  const lines = [t('commandLabel'), plan.command, '', `${t('targetLabel')} ${login(plan, target)}`]
  if (through) lines.push(`${t('throughLabel')} ${through}`)
  if (plan.shellIntegration) {
    lines.push(
      '',
      plan.helperIntegration
        ? t('helperIntegrationNote', { product: PRODUCT_DISPLAY_NAME })
        : t('integrationNote', { product: PRODUCT_DISPLAY_NAME }),
    )
  }
  lines.push('', t('confirmNote'))
  return {
    title: t('confirmTitle'),
    message: t('confirmMessage', { destination: plan.destination }),
    detail: lines.join('\n'),
    confirmLabel: t('approve'),
    cancelLabel: t('deny'),
  }
}
