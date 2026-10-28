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
  sessionFolder: (resume: AgentResume) => string | null
  onResume: (identity: PaneIdentity, resume: AgentResume) => void
}

async function storedResume(
  deps: PaneResumeDeps,
  identity: PaneIdentity,
): Promise<AgentResume | null> {
  const res = await deps.execCommand(targetOf(identity), 'pane.resumeToken', undefined, true)
  return res.ok ? parseAgentResume((res.result as { resume?: unknown } | undefined)?.resume) : null
}

async function paneAgent(
  deps: PaneResumeDeps,
  identity: PaneIdentity,
): Promise<ResumableAgent | null> {
  const program = deps.foregroundProgram(identity.paneId)
  if (isResumableAgent(program)) return program
  return (await storedResume(deps, identity))?.agent ?? null
}

async function agentFolder(
  deps: PaneResumeDeps,
  identity: PaneIdentity,
  resume: AgentResume,
): Promise<string | null> {
  return deps.sessionFolder(resume) ?? (await deps.agentCwd(identity.paneId))
}

export async function refreshResumeFolder(
  deps: PaneResumeDeps,
  identity: PaneIdentity,
): Promise<void> {
  const stored = await storedResume(deps, identity)
  if (!stored) return
  const cwd = await agentFolder(deps, identity, stored)
  if (!cwd || cwd === stored.cwd) return
  await deps.execCommand(targetOf(identity), 'resume.set', { ...stored, cwd }, true)
}

export function registerPaneResumeMethods(deps: PaneResumeDeps): void {
  registerControlMethod('pane.setResume', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      const reported = parseAgentResume(params)
      if (!reported) return { ok: false, error: 'invalid-resume' }
      const { cwd: _callerCwd, ...rest } = reported
      const resume = parseAgentResume({
        ...rest,
        cwd: await agentFolder(deps, ctx.identity, reported),
      })
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
