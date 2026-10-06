import type { AttentionState, CommandResult, CommandTarget } from '../shared/types'
import { ensureCaps } from './controlElevation'
import { registerTargetableMethod } from './controlServer'
import { type PaneIdentity, resolveExternal } from './idRegistry'

export type AttentionVerb = Exclude<AttentionState, 'none'> | 'clear'

export const ATTENTION_VERBS: readonly AttentionVerb[] = [
  'waiting',
  'done',
  'working',
  'error',
  'clear',
]

export const ATTENTION_MESSAGE_MAX = 1024

export interface AttentionDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

export function targetOf(identity: PaneIdentity): CommandTarget {
  return { windowId: identity.windowId, workspaceId: identity.workspaceId, paneId: identity.paneId }
}

export function clampMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const trimmed = message.trim()
  return trimmed ? trimmed.slice(0, ATTENTION_MESSAGE_MAX) : undefined
}

function isVerb(value: unknown): value is AttentionVerb {
  return typeof value === 'string' && (ATTENTION_VERBS as readonly string[]).includes(value)
}

export function registerAttentionMethods(deps: AttentionDeps): void {
  registerTargetableMethod('pane.setAttention', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      const { state, message, paneId } = (params ?? {}) as {
        state?: unknown
        message?: unknown
        paneId?: unknown
      }
      if (!isVerb(state)) {
        return { ok: false, error: 'invalid-state', message: ATTENTION_VERBS.join('|') }
      }
      let target = ctx.identity
      if (typeof paneId === 'string' && paneId && paneId !== ctx.identity.externalId) {
        await ensureCaps(
          ctx.authed,
          ctx.identity,
          ['all-workspaces'],
          'pane.setAttention',
          JSON.stringify({ paneId, state }),
        )
        const other = resolveExternal(paneId)
        if (!other) return { ok: false, error: 'not-found' }
        target = other
      }
      const res = await deps.execCommand(targetOf(target), 'attention.set', {
        state: state === 'clear' ? 'none' : state,
        message: clampMessage(message),
      })
      return res.ok
        ? { ok: true }
        : { ok: false, error: res.error.code, message: res.error.message }
    },
  })
}
