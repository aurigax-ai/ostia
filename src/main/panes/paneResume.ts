import {
  type AgentResume,
  isResumableAgent,
  parseAgentResume,
  type ResumableAgent,
} from '../../shared/agents/agentResume'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import { targetOf } from '../attention/attention'
import { registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'

export interface PaneResumeDeps {
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  foregroundProgram: (paneId: string) => string | null
  agentCwd: (paneId: string) => Promise<string | null>
  onResume: (identity: PaneIdentity, resume: AgentResume) => void
}

async function paneAgent(
  deps: PaneResumeDeps,
  identity: PaneIdentity,
): Promise<ResumableAgent | null> {
  const program = deps.foregroundProgram(identity.paneId)
  if (isResumableAgent(program)) return program
  const res = await deps.execCommand(targetOf(identity), 'pane.resumeToken', undefined, true)
  if (!res.ok) return null
  return parseAgentResume((res.result as { resume?: unknown } | undefined)?.resume)?.agent ?? null
}

export function registerPaneResumeMethods(deps: PaneResumeDeps): void {
  registerControlMethod('pane.setResume', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      const reported = parseAgentResume(params)
      if (!reported) return { ok: false, error: 'invalid-resume' }
      const { cwd: _callerCwd, ...rest } = reported
      const resume = parseAgentResume({ ...rest, cwd: await deps.agentCwd(ctx.identity.paneId) })
      if (!resume) return { ok: false, error: 'invalid-resume' }
      const agent = await paneAgent(deps, ctx.identity)
      if (agent !== null && agent !== resume.agent) return { ok: false, error: 'agent-mismatch' }
      deps.onResume(ctx.identity, resume)
      const res = await deps.execCommand(targetOf(ctx.identity), 'resume.set', resume, true)
      return res.ok
        ? { ok: true }
        : { ok: false, error: res.error.code, message: res.error.message }
    },
  })
}
