import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OstiaExtension } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { closeHarnesses, type HostHarness, hostHarness, settle } from './fakeExt'
import { createPaneSignals } from './paneSignals'

afterEach(() => closeHarnesses())

const graph = (trigger: string) => `version: 1
on: [${trigger}]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`

async function harness(files: Record<string, string>): Promise<HostHarness> {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-signals-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  const h = await hostHarness({ workspaceId: 'w1', workDir, kind: 'terminal' })
  for (const name of Object.keys(files)) {
    const listing = await h.runner.graph('w1', name)
    if (!listing?.entry.loaded) throw new Error(JSON.stringify(listing?.problems))
    expect(await h.runner.enable('w1', name, listing.entry.loaded.fingerprint)).toEqual({
      ok: true,
    })
  }
  return h
}

const runsOf = async (h: HostHarness, name: string) =>
  (await h.runner.runs('w1')).filter((r) => r.graph === name)

describe('pane signals as triggers', () => {
  it('a command with no exit code, or one in a remote pane, never fires a command trigger', async () => {
    const h = await harness({
      any: graph('{ command: {} }'),
      zero: graph('{ command: { exit: zero } }'),
    })
    const { onEvent } = createPaneSignals({
      ext: h.ext as OstiaExtension,
      runner: h.runner,
      refresh: async () => {},
    })
    onEvent('command.finished', { paneId: 'p1', workspaceId: 'w1' })
    onEvent('command.finished', { paneId: 'p1', workspaceId: 'w1', exitCode: 0, remote: true })
    await settle()
    expect([(await runsOf(h, 'any')).length, (await runsOf(h, 'zero')).length]).toEqual([0, 0])
    onEvent('command.finished', { paneId: 'p1', workspaceId: 'w1', exitCode: 0 })
    await settle()
    expect([(await runsOf(h, 'any')).length, (await runsOf(h, 'zero')).length]).toEqual([1, 1])
  })

  it('an agent that is waiting fires a state: waiting trigger with the pane in trigger.pane', async () => {
    const h = await harness({ nudge: graph('{ agent: { state: waiting, agent: codex } }') })
    h.panes.push({ paneId: 'p9', workspaceId: 'w1', agent: 'codex' } as (typeof h.panes)[number])
    const { onEvent } = createPaneSignals({
      ext: h.ext as OstiaExtension,
      runner: h.runner,
      refresh: async () => {},
    })
    onEvent('pane.attention', { paneId: 'p9', workspaceId: 'w1', state: 'waiting' })
    await settle()
    const runs = await runsOf(h, 'nudge')
    expect(runs).toHaveLength(1)
    const [first] = h.journal(runs[0]?.runId as string) as { trigger?: unknown }[]
    expect(first?.trigger).toMatchObject({ pane: 'p9', state: 'waiting' })
  })
})
