import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import { targetOf } from '../attention/attention'
import { registerControlMethod } from '../control/controlServer'
import { fail, record } from './paneReach'

export interface PaneKeepAwakeDeps {
  agentRunning: (paneId: string) => boolean
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
}

export function registerPaneKeepAwakeMethods(deps: PaneKeepAwakeDeps): void {
  registerControlMethod('pane.keepAwake', {
    cap: 'drive-self',
    handler: async (raw, ctx) => {
      const p = record(raw)
      const me = ctx.identity
      if (typeof p.on !== 'boolean') throw fail('bad-request: on')
      if (me.manager) throw fail('not-available: the manager pane is never hibernated')
      if (p.on && !deps.agentRunning(me.paneId)) {
        throw fail(
          'not-an-agent: only a claude or codex agent running in this pane can be kept awake',
        )
      }
      const res = await deps.execCommand(targetOf(me), 'pane.keepAwake', { on: p.on }, true)
      if (!res.ok) throw fail(`${res.error.code}: ${res.error.message}`)
      const keepAwake = (res.result as { keepAwake?: unknown } | undefined)?.keepAwake === true
      if (keepAwake !== p.on)
        throw fail(
          'not-kept: the tab has no agent session yet; run ostia pane keep-awake again in a moment',
        )
      return { ok: true, paneId: me.externalId, keepAwake }
    },
  })
}
