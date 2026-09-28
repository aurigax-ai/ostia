import { parseAgentResume } from '../shared/agentResume'
import type { CommandResult, CommandTarget } from '../shared/types'
import { targetOf } from './attention'
import { registerControlMethod } from './controlServer'

export interface PaneResumeDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

export function registerPaneResumeMethods(deps: PaneResumeDeps): void {
  registerControlMethod('pane.setResume', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      const resume = parseAgentResume(params)
      if (!resume) return { ok: false, error: 'invalid-resume' }
      const res = await deps.execCommand(targetOf(ctx.identity), 'resume.set', resume)
      return res.ok
        ? { ok: true }
        : { ok: false, error: res.error.code, message: res.error.message }
    },
  })
}
