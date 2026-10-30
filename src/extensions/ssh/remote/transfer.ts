import type { ConfirmRequest, ToolRun } from '@aurigax-ai/ostia-extension-sdk'
import { quoteArgv } from '../../../shared/terminal/shellQuote'
import type { HelperConsent } from '../consent'
import type { ConnectPlan } from '../plan'

export type Git = (args: string[], cwd: string) => Promise<ToolRun>

export interface Consenting {
  confirm: (req: ConfirmRequest) => Promise<boolean>
  consent: HelperConsent
  now?: () => Date
}

export class GitFailure extends Error {}

export function transferArgs(plan: ConnectPlan): string[] {
  const route = plan.argv.slice(0, plan.argv.indexOf('--'))
  const ssh = quoteArgv([...route, '-o', 'ConnectTimeout=8'])
  return ['-c', 'core.hooksPath=/dev/null', '-c', `core.sshCommand=${ssh}`]
}

export async function gitText(git: Git, cwd: string, args: string[]): Promise<string> {
  const run = await git(args, cwd)
  if (run.code !== 0) {
    throw new GitFailure(run.stderr.trim().slice(-400) || `git ${args[0]} failed`)
  }
  return run.stdout
}

export async function consented(
  deps: Consenting,
  key: string,
  request: ConfirmRequest,
): Promise<boolean> {
  const record = deps.consent.get(key)
  if (record) return record.answer === 'allowed'
  const approved = await deps.confirm(request)
  const at = (deps.now?.() ?? new Date()).toISOString()
  deps.consent.set(key, { answer: approved ? 'allowed' : 'refused', at })
  return approved
}
