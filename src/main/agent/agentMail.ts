import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  type AgentCoreDeps,
  type CoreLifecycle,
  type CoreScope,
  coreContext,
} from './agentCoreCall'

export interface PromptMail {
  text: string
  ack: () => Promise<void>
}

export type TakePromptMail = (
  scope: CoreScope,
  lifecycle: CoreLifecycle,
) => Promise<PromptMail | null>

export function createPromptMail(
  deps: Pick<AgentCoreDeps, 'identityOf' | 'sandboxed' | 'isManagerSession' | 'call'>,
): TakePromptMail {
  return async (scope, lifecycle) => {
    const resolved = coreContext(deps, scope, lifecycle)
    if (!resolved.ok) return null
    const { ctx } = resolved
    const answer = await deps.call('bus.context', {}, ctx).catch(() => null)
    if (!isRecord(answer) || typeof answer.text !== 'string' || !answer.text) return null
    const { lease } = answer
    return {
      text: answer.text,
      ack: async () => {
        if (typeof lease === 'string') await deps.call('bus.ack', { lease }, ctx)
      },
    }
  }
}
