import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandTarget } from '../../shared/types'
import type { PaneIdentity } from '../control/idRegistry'
import { wakeHibernatedPane } from './paneWake'

const worker: PaneIdentity = {
  kind: 'pane',
  externalId: 'ext-fixer',
  token: 'tok',
  windowId: 'win-1',
  workspaceId: 'ws-1',
  paneId: 'pane-fixer',
}

function windowAnswering(answer: CommandResult) {
  const asked: Array<{ target: CommandTarget; id: string }> = []
  const execCommand = async (target: CommandTarget, id: string): Promise<CommandResult> => {
    asked.push({ target, id })
    return answer
  }
  return { asked, execCommand }
}

describe('wakeHibernatedPane', () => {
  it('asks the worker’s own window to wake it and reports that it woke', async () => {
    const { asked, execCommand } = windowAnswering({ ok: true, result: { woke: true } })
    await expect(wakeHibernatedPane(execCommand, worker)).resolves.toEqual({ woke: true })
    expect(asked).toEqual([
      { target: { windowId: 'win-1', workspaceId: 'ws-1', paneId: 'pane-fixer' }, id: 'pane.wake' },
    ])
  })

  it('passes on the session conflict the window named', async () => {
    const { execCommand } = windowAnswering({
      ok: true,
      result: { woke: false, conflict: 'pane-other' },
    })
    await expect(wakeHibernatedPane(execCommand, worker)).resolves.toEqual({
      woke: false,
      conflict: 'pane-other',
    })
  })

  it('counts a pane the window did not wake, a failed command or a malformed answer as not woken', async () => {
    for (const answer of [
      { ok: true, result: { woke: false } },
      { ok: false, error: { code: 'command-failed', message: 'gone' } },
      { ok: true, result: { woke: 'yes', conflict: 7 } },
      { ok: true, result: undefined },
    ] as CommandResult[]) {
      const { execCommand } = windowAnswering(answer)
      await expect(wakeHibernatedPane(execCommand, worker)).resolves.toEqual({ woke: false })
    }
  })
})
