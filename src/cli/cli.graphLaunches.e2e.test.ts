import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { graphsHarness, type Harness, POLL } from '../../test/graphsHarness'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

const { questions } = await import('../main/approvals/questions')

describe('the graphs host asks to start with the window (real extension, real socket)', () => {
  let h: Harness

  beforeAll(async () => {
    h = await graphsHarness({ launches: true })
  }, 120_000)

  afterAll(() => h.stopAll())

  it('asks to start with the window while a run waits and stops asking once it ends', async () => {
    h.writeGraph(
      'held',
      `version: 1
on: [{ manual: {} }]
start: ask
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: ask, kind: approval, with: { question: "Still waiting after the restart?" } }
edges: []
`,
    )
    expect((await h.enable('held')).ok).toBe(true)
    expect(h.launches?.has('graphs')).toBe(false)

    expect((await h.panel('runNow', { name: 'held' })).ok).toBe(true)
    const shown = await vi.waitUntil(
      () =>
        questions()
          ?.stateFor('7')
          .pending.find((q) => q.question === 'Still waiting after the restart?'),
      POLL,
    )
    await vi.waitUntil(() => h.launches?.has('graphs'), POLL)

    questions()?.answer('7', shown.id, { choices: [0], text: '' })
    await vi.waitUntil(() => !h.launches?.has('graphs'), POLL)
  })
})
