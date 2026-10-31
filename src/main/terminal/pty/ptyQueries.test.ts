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

const report = (host: string, path: string) => `\x1b]7;file://${host}${path}\x07`

async function queriesWith(
  output: string,
  own: string | null,
  entry: Partial<PtyEntry> = {},
): Promise<{ queries: ReturnType<typeof createPtyQueries>; asked: number[] }> {
  const mirror = new ScreenMirror(80, 24)
  mirrors.push(mirror)
  mirror.write(output)
  await mirror.flush()
  const asked: number[] = []
  const pane = {
    paneId: 'p1',
    mirror,
    pty: { process: 'claude', pid: 4242 },
    shell: 'bash',
    sandboxed: false,
    kept: null,
    ...entry,
  } as unknown as PtyEntry
  const queries = createPtyQueries({
    ptys: new Map([['p1', pane]]),
    agentRunning: new AgentRunningPanes(() => {}),
    workspaceSandboxes: {} as WorkspaceSandboxes,
    foregroundCwd: async (pid) => {
      asked.push(pid)
      return own
    },
  })
  return { queries, asked }
}

describe('agentCwd', () => {
  it('answers the folder of the agent process itself, after a cd on the same line', async () => {
    const { queries, asked } = await queriesWith(report(hostname(), '/home/u'), '/home/u/work/tree')
    expect(await queries.agentCwd('p1')).toBe('/home/u/work/tree')
    expect(asked).toEqual([4242])
    expect(queries.foregroundProgram('p1')).toBe('claude')
  })

  it('falls back to the folder the shell last reported on this machine when the process cannot be read', async () => {
    const out = report(hostname(), '/home/u/old') + report(hostname(), '/home/u/work/tree')
    expect(await (await queriesWith(out, null)).queries.agentCwd('p1')).toBe('/home/u/work/tree')
  })

  it('reads the foreground process of a sandboxed pane like any other', async () => {
    const { queries, asked } = await queriesWith(report(hostname(), '/w'), '/w/tree', {
      sandboxed: true,
    })
    expect(await queries.agentCwd('p1')).toBe('/w/tree')
    expect(asked).toEqual([4242])
  })

  it('reads the foreground process of the tmux pane’s shell for a kept pane, not the attach client', async () => {
    const kept = { shellPid: async () => 9001 } as unknown as PtyEntry['kept']
    const { queries, asked } = await queriesWith(report(hostname(), '/w'), '/w/tree', { kept })
    expect(await queries.agentCwd('p1')).toBe('/w/tree')
    expect(asked).toEqual([9001])
  })

  it('uses the shell’s report for a kept pane whose tmux pane cannot be asked', async () => {
    const kept = { shellPid: async () => null } as unknown as PtyEntry['kept']
    const { queries, asked } = await queriesWith(report(hostname(), '/w'), '/elsewhere', { kept })
    expect(await queries.agentCwd('p1')).toBe('/w')
    expect(asked).toEqual([])
  })

  it('answers nothing for a remote report, no report or an unknown pane', async () => {
    const remote = await queriesWith(report('elsewhere.example', '/home/u'), null)
    expect(await remote.queries.agentCwd('p1')).toBeNull()
    const quiet = await queriesWith('no report here', null)
    expect(await quiet.queries.agentCwd('p1')).toBeNull()
    expect(await quiet.queries.agentCwd('p2')).toBeNull()
  })
})
