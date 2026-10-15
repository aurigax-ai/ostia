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

  it('reads no process for a sandboxed or kept pane and uses the shell’s report', async () => {
    for (const entry of [{ sandboxed: true }, { kept: {} as PtyEntry['kept'] }]) {
      const { queries, asked } = await queriesWith(report(hostname(), '/w'), '/elsewhere', entry)
      expect(await queries.agentCwd('p1')).toBe('/w')
      expect(asked).toEqual([])
    }
  })

  it('answers nothing for a remote report, no report or an unknown pane', async () => {
    const remote = await queriesWith(report('elsewhere.example', '/home/u'), null)
    expect(await remote.queries.agentCwd('p1')).toBeNull()
    const quiet = await queriesWith('no report here', null)
    expect(await quiet.queries.agentCwd('p1')).toBeNull()
    expect(await quiet.queries.agentCwd('p2')).toBeNull()
  })
})
