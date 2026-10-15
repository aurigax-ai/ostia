import { hostname } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRunningPanes } from '../../agents/agentRunning'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { ScreenMirror } from '../screenMirror'
import { createPtyQueries } from './ptyQueries'
import type { PtyEntry } from './ptyRegistry'

const mirrors: ScreenMirror[] = []

afterEach(() => {
  for (const mirror of mirrors.splice(0)) mirror.dispose()
})

async function queriesWith(paneId: string, output: string) {
  const mirror = new ScreenMirror(80, 24)
  mirrors.push(mirror)
  mirror.write(output)
  await mirror.flush()
  const entry = {
    paneId,
    mirror,
    pty: { process: 'claude' },
    shell: 'bash',
    sandboxed: false,
  } as unknown as PtyEntry
  return createPtyQueries({
    ptys: new Map([[paneId, entry]]),
    agentRunning: new AgentRunningPanes(() => {}),
    workspaceSandboxes: {} as WorkspaceSandboxes,
  })
}

describe('reportedCwd', () => {
  it('answers the folder the pane’s own shell last reported on this machine', async () => {
    const queries = await queriesWith(
      'p1',
      `\x1b]7;file://${hostname()}/home/u/old\x07\x1b]7;file://${hostname()}/home/u/work/tree\x07`,
    )
    expect(queries.reportedCwd('p1')).toBe('/home/u/work/tree')
    expect(queries.foregroundProgram('p1')).toBe('claude')
  })

  it('answers nothing for a remote folder, a pane that never reported one or an unknown pane', async () => {
    expect(
      (await queriesWith('p1', '\x1b]7;file://elsewhere.example/home/u\x07')).reportedCwd('p1'),
    ).toBeNull()
    const quiet = await queriesWith('p1', 'no report here')
    expect(quiet.reportedCwd('p1')).toBeNull()
    expect(quiet.reportedCwd('p2')).toBeNull()
  })
})
