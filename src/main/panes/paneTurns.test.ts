import { describe, expect, it } from 'vitest'
import { PANE_TURNS_MAX, PaneTurns, TURN_OUTPUTS_MAX } from './paneTurns'

describe('PaneTurns', () => {
  it('PHT-C6 groups steps under the prompt that started them and ends the turn at Stop', () => {
    const turns = new PaneTurns(() => 1000)
    turns.report('p1', { kind: 'prompt', text: 'fix the build' })
    turns.report('p1', { kind: 'step', step: 'read', target: 'src/a.ts' })
    turns.report('p1', { kind: 'step', step: 'edit', target: 'src/a.ts' })
    turns.report('p1', { kind: 'step', step: 'edit', target: 'src/a.ts' })
    turns.report('p1', { kind: 'step', step: 'edit', target: 'src/b.ts' })
    turns.report('p1', { kind: 'step', step: 'command', target: 'pnpm test' })
    turns.report('p1', { kind: 'result', exitCode: 1, output: 'FAIL a.test.ts' })
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
      turns.report('p1', { kind: 'step', step: 'command', target: `run ${i}` })
      turns.report('p1', { kind: 'result', output: `out ${i}` })
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

  it('PHT-C8 gives each command result to its own step and starts a turn for steps without a prompt', () => {
    const turns = new PaneTurns()
    turns.report('p2', { kind: 'step', step: 'command', target: 'a' })
    turns.report('p2', { kind: 'step', step: 'command', target: 'b' })
    turns.report('p2', { kind: 'result', exitCode: 0 })
    turns.report('p2', { kind: 'result', exitCode: 2, output: 'b failed' })
    turns.report('p2', { kind: 'result', exitCode: 3, output: 'stray' })
    const [turn] = turns.list('p2')
    expect(turn.prompt).toBeUndefined()
    expect(turn.steps.map((s) => [s.target, s.exitCode, s.output])).toEqual([
      ['a', 0, false],
      ['b', 2, true],
    ])
    expect(turns.list('other')).toEqual([])
  })
})
