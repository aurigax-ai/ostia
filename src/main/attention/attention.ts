import type { AttentionState } from '../../shared/attention/attention'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import { ensureCaps } from '../approvals/controlElevation'
import { registerTargetableMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'

type AttentionVerb = Exclude<AttentionState, 'none'> | 'clear'

const ATTENTION_VERBS: readonly AttentionVerb[] = ['waiting', 'done', 'working', 'error', 'clear']

const ATTENTION_MESSAGE_MAX = 1024

export interface AttentionDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  reported?: (paneId: string) => void
  journal?: { hook: (paneId: string, kind: string) => void }
  closing?: (
    paneId: string,
    state: string,
    message: string | undefined,
    stop: string | undefined,
  ) => void
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
      const { state, message, paneId, closing, soft } = (params ?? {}) as {
        state?: unknown
        message?: unknown
        paneId?: unknown
        closing?: unknown
        soft?: unknown
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
      deps.closing?.(
        target.paneId,
        state,
        clampMessage(message),
        typeof closing === 'string' ? closing : undefined,
      )
      const res = await deps.execCommand(targetOf(target), 'attention.set', {
        state: state === 'clear' ? 'none' : state,
        message: clampMessage(message),
        ...(soft === true ? { soft } : {}),
      })
      if (!res.ok) return { ok: false, error: res.error.code, message: res.error.message }
      deps.reported?.(target.paneId)
      deps.journal?.hook(target.externalId, `state-${state}`)
      return { ok: true }
    },
  })
}
