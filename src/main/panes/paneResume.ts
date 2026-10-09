import { type AgentResume, parseAgentResume } from '../../shared/agents/agentResume'
import type { CommandResult, CommandTarget } from '../../shared/types'
import { targetOf } from '../attention/attention'
import { registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'

export interface PaneResumeDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  onResume: (identity: PaneIdentity, resume: AgentResume) => void
}

export function registerPaneResumeMethods(deps: PaneResumeDeps): void {
  registerControlMethod('pane.setResume', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      const resume = parseAgentResume(params)
      if (!resume) return { ok: false, error: 'invalid-resume' }
      deps.onResume(ctx.identity, resume)
      const res = await deps.execCommand(targetOf(ctx.identity), 'resume.set', resume)
      return res.ok
        ? { ok: true }
        : { ok: false, error: res.error.code, message: res.error.message }
    },
  })
}
