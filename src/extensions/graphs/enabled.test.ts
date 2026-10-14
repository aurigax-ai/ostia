import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, settle } from '@aurigax-ai/graph/testing'
import { describe, expect, it } from 'vitest'
import { fakeExt } from './fakeExt'
import { GraphsRunner } from './runner'

const GRAPH = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: notify, with: { title: "hello" } }
edges: []
`

function setup() {
  const data = mkdtempSync(join(tmpdir(), 'graphs-data-'))
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-ws-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  const file = join(workDir, '.ostia/graphs/g.yaml')
  writeFileSync(file, GRAPH)
  const fake = fakeExt()
  const runner = new GraphsRunner({
    ext: fake.ext,
    dataDir: data,
    clock: new FakeClock(),
    changed: () => {},
  })
  runner.setWorkspaces([
    { workspaceId: 'w1', workDir, kind: 'terminal' },
    { workspaceId: 'w2', workDir, kind: 'terminal' },
  ])
  const enable = (name = 'g', ws = 'w1') => {
    const listing = runner.graph(ws, name)
    return runner.enable(ws, name, listing?.entry.loaded?.fingerprint ?? '')
  }
  const state = (name = 'g', ws = 'w1') => runner.graph(ws, name)?.state
  return { data, workDir, file, fake, runner, enable, state }
}

describe('enabling a graph', () => {
  it('GRF-C81 the click stores the workspace, the real path and the fingerprint in a 0600 enabled.json', () => {
    const { data, file, enable } = setup()
    expect(enable()).toEqual({ ok: true })
    const path = join(data, 'enabled.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      enabled: { workspaceId: string; realPath: string; fingerprint: string }[]
    }
    expect(stored.enabled).toEqual([
      expect.objectContaining({
        workspaceId: 'w1',
        realPath: expect.stringContaining('g.yaml'),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ])
    expect(stored.enabled[0].realPath.endsWith(file.slice(file.indexOf('/.ostia')))).toBe(true)
  })

  it('GRF-C84 and GRF-C85 an edit disables it at once, and restoring the old text does not enable it again', () => {
    const { file, enable, state, data } = setup()
    enable()
    writeFileSync(file, GRAPH.replace('hello', 'hellO'))
    expect(state()).toBe('changed')
    expect(readFileSync(join(data, 'enabled.json'), 'utf8')).not.toContain('"fingerprint"')
    writeFileSync(file, GRAPH)
    expect(state()).toBe('changed')
  })

  it('GRF-C86 a symlink, a copy and a second workspace on the same folder are not enabled', () => {
    const { file, workDir, enable, state, runner } = setup()
    enable()
    copyFileSync(file, join(workDir, '.ostia/graphs/other.yaml'))
    expect(state('other')).toBe('not-enabled')
    expect(state('g', 'w2')).toBe('not-enabled')
    const elsewhere = join(workDir, 'elsewhere.yaml')
    copyFileSync(file, elsewhere)
    renameSync(file, `${file}.bak`)
    symlinkSync(elsewhere, file)
    const listing = runner.graph('w1', 'g')
    expect(listing?.state).toBe('invalid')
    expect(listing?.problems.map((p) => p.code)).toEqual(['not-a-regular-file'])
  })

  it('GRF-C87 a change only under ui keeps it enabled and nothing of ui reaches a run', async () => {
    const { file, enable, state, runner } = setup()
    enable()
    writeFileSync(file, `${GRAPH}ui: { positions: { a: [10, 20] }, note: "ignore me" }\n`)
    expect(state()).toBe('enabled')
    const res = runner.start('w1', 'g', { byAgent: false, inputs: [] })
    if (!res.ok || !('runId' in res)) throw new Error(JSON.stringify(res))
    await settle()
    const run = runner.engine.run(res.runId)
    expect(JSON.stringify(run?.state.graph)).not.toContain('ignore me')
    expect(Object.keys(run?.state.graph ?? {})).not.toContain('ui')
  })
})
