import { describe, expect, it, vi } from 'vitest'
import { PANE_TURNS_MAX, PaneTurns, registerPaneTurnMethods, TURN_OUTPUTS_MAX } from './paneTurns'

const methods = vi.hoisted(
  () => new Map<string, { cap?: string; handler: (p: unknown, ctx: unknown) => unknown }>(),
)

vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, spec: { cap?: string; handler: () => unknown }) =>
    methods.set(name, spec),
}))

describe('PaneTurns', () => {
  it('PHT-C6 groups steps under the prompt that started them and ends the turn at Stop', () => {
    const turns = new PaneTurns(() => 1000)
    turns.report('p1', { kind: 'prompt', text: 'fix the build' })
    turns.report('p1', { kind: 'step', step: 'read', target: 'src/a.ts' })
    turns.report('p1', { kind: 'step', step: 'edit', target: 'src/a.ts' })
    turns.report('p1', { kind: 'step', step: 'edit', target: 'src/a.ts' })
    turns.report('p1', { kind: 'step', step: 'edit', target: 'src/b.ts' })
    turns.report('p1', {
      kind: 'step',
      step: 'command',
      target: 'pnpm test',
      exitCode: 1,
      output: 'FAIL a.test.ts',
    })
    turns.report('p1', { kind: 'stop', message: 'Fixed it.' })
    const [turn] = turns.list('p1')
    expect(turn).toMatchObject({
      id: 't1',
      startedAt: 1000,
      prompt: 'fix the build',
      final: 'Fixed it.',
      commands: 1,
      filesEdited: 2,
      ended: true,
    })
    expect(turn.steps.map((s) => s.kind)).toEqual(['read', 'edit', 'edit', 'edit', 'command'])
    expect(turn.steps[4]).toEqual({
      id: 't1s5',
      kind: 'command',
      target: 'pnpm test',
      exitCode: 1,
      output: true,
    })
    expect(turns.output('p1', 't1s5')).toBe('FAIL a.test.ts')
    expect(turns.output('p1', 't1s1')).toBeNull()
  })

  it('PHT-C7 keeps only the last 50 turns and the last 20 command outputs, and forgets a closed pane', () => {
    const turns = new PaneTurns()
    for (let i = 0; i < PANE_TURNS_MAX + 5; i++) {
      turns.report('p1', { kind: 'prompt', text: `job ${i}` })
      turns.report('p1', { kind: 'step', step: 'command', target: `run ${i}`, output: `out ${i}` })
    }
    const list = turns.list('p1')
    expect(list).toHaveLength(PANE_TURNS_MAX)
    expect(list[0].prompt).toBe('job 5')
    const withOutput = list.filter((t) => t.steps[0]?.output)
    expect(withOutput).toHaveLength(TURN_OUTPUTS_MAX)
    expect(withOutput[0].prompt).toBe(`job ${PANE_TURNS_MAX + 5 - TURN_OUTPUTS_MAX}`)
    expect(turns.output('p1', list[0].steps[0].id)).toBeNull()

    turns.drop('p1')
    expect(turns.list('p1')).toEqual([])
  })

  it('PHT-C8 keeps each command with its own result, and a late step after Stop in that turn', () => {
    const turns = new PaneTurns()
    turns.report('p2', { kind: 'step', step: 'command', target: 'a', exitCode: 0 })
    turns.report('p2', {
      kind: 'step',
      step: 'command',
      target: 'b',
      exitCode: 2,
      output: 'b failed',
    })
    turns.report('p2', { kind: 'stop', message: 'done' })
    turns.report('p2', { kind: 'step', step: 'read', target: 'late.ts' })
    turns.report('p2', { kind: 'prompt', text: 'next one' })
    turns.report('p2', { kind: 'step', step: 'command', target: 'c', exitCode: 3 })
    const [first, second] = turns.list('p2')
    expect(first.prompt).toBeUndefined()
    expect(first.steps.map((s) => [s.target, s.exitCode, s.output])).toEqual([
      ['a', 0, false],
      ['b', 2, true],
      ['late.ts', undefined, false],
    ])
    expect(second.steps.map((s) => [s.target, s.exitCode])).toEqual([['c', 3]])
    expect(turns.output('p2', 't1s2')).toBe('b failed')
    expect(turns.list('other')).toEqual([])
  })
})

describe('pane.reportTurn', () => {
  it('PHT-C13 records a report only for the calling pane itself, never for another caller', async () => {
    const turns = new PaneTurns()
    registerPaneTurnMethods(turns)
    const method = methods.get('pane.reportTurn')
    expect(method?.cap).toBe('drive-self')
    const call = (identity: unknown, params: unknown) =>
      method?.handler(params, { identity }) as Promise<unknown>

    expect(
      await call(
        { kind: 'pane', paneId: 'p1' },
        { kind: 'prompt', text: 'hello there', paneId: 'p9' },
      ),
    ).toEqual({ ok: true })
    expect(turns.list('p1').map((t) => t.prompt)).toEqual(['hello there'])
    expect(turns.list('p9')).toEqual([])

    expect(await call({ kind: 'extension', paneId: '' }, { kind: 'prompt', text: 'x y' })).toEqual({
      ok: false,
      error: 'not-a-pane',
    })
    expect(await call({ kind: 'pane', paneId: 'p1' }, { kind: 'bogus' })).toEqual({ ok: true })
    expect(turns.list('p1')).toHaveLength(1)
  })
})
