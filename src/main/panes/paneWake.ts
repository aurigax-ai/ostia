import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import { targetOf } from '../attention/attention'
import type { PaneIdentity } from '../control/idRegistry'

type ExecCommand = (target: CommandTarget, id: string) => Promise<CommandResult>

export async function wakeHibernatedPane(
  execCommand: ExecCommand,
  to: PaneIdentity,
): Promise<{ woke: boolean; conflict?: string }> {
  const res = await execCommand(targetOf(to), 'pane.wake')
  const result = res.ok ? (res.result as { woke?: unknown; conflict?: unknown }) : undefined
  return {
    woke: result?.woke === true,
    ...(typeof result?.conflict === 'string' ? { conflict: result.conflict } : {}),
  }
}
