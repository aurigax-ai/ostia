import { describe, expect, it } from 'vitest'
import { FlagError, parseArgs } from './args'

const RUN = { values: { name: '--name', cwd: '--cwd' } } as const

function problem(run: () => unknown): FlagError {
  try {
    run()
  } catch (err) {
    if (err instanceof FlagError) return err
    throw err
  }
  throw new Error('expected a FlagError')
}

describe('parseArgs', () => {
  it('reads a value flag before, between and after the positionals', () => {
    for (const argv of [
      ['--name', 'web', 'pnpm dev', 'extra'],
      ['pnpm dev', '--name', 'web', 'extra'],
      ['pnpm dev', 'extra', '--name', 'web'],
    ]) {
      const parsed = parseArgs(argv, RUN)
      expect(parsed.positional).toEqual(['pnpm dev', 'extra'])
      expect(parsed.values).toEqual({ name: 'web' })
    }
  })

  it('accepts --flag=value and keeps the last value of a repeated flag', () => {
    expect(parseArgs(['--name=web', '--name', 'api'], RUN).values.name).toBe('api')
  })

  it('takes whatever follows a value flag as its value, even a flag or a lone dash', () => {
    expect(parseArgs(['--name', '--cwd'], RUN).values).toEqual({ name: '--cwd' })
    expect(parseArgs(['--name', '-'], RUN).values).toEqual({ name: '-' })
  })

  it('collects a repeated list flag in order and starts each parse empty', () => {
    const spec = { lists: { choice: '--choice' } } as const
    expect(parseArgs(['--choice', 'lint', 'q', '--choice', 'unit'], spec).lists.choice).toEqual([
      'lint',
      'unit',
    ])
    expect(parseArgs(['q'], spec).lists.choice).toEqual([])
  })

  it('reports each boolean flag as true or false', () => {
    const spec = { booleans: { json: '--json', all: '--all' } } as const
    expect(parseArgs(['list', '--json'], spec).booleans).toEqual({ json: true, all: false })
  })

  it('reads a short alias and a group of short booleans', () => {
    const spec = {
      values: { depth: '-d, --depth' },
      booleans: { interactive: '-i', compact: '-c' },
    } as const
    const parsed = parseArgs(['-ic', '-d', '3'], spec)
    expect(parsed.values).toEqual({ depth: '3' })
    expect(parsed.booleans).toEqual({ interactive: true, compact: true })
  })

  it('refuses an unknown flag by the name the caller wrote', () => {
    const err = problem(() => parseArgs(['pnpm dev', '--nmae', 'web'], RUN))
    expect(err.problem).toBe('unknown')
    expect(err.flag).toBe('--nmae')
    expect(err.message).toBe('unknown flag --nmae')
    expect(problem(() => parseArgs(['-x'], RUN)).message).toBe('unknown flag -x')
  })

  it('refuses a value flag with nothing after it', () => {
    const err = problem(() => parseArgs(['pnpm dev', '--cwd'], RUN))
    expect(err.problem).toBe('missing-value')
    expect(err.flag).toBe('--cwd')
    expect(err.message).toBe('--cwd needs a value')
    expect(problem(() => parseArgs(['-d'], { values: { depth: '-d, --depth' } })).message).toBe(
      '--depth needs a value',
    )
  })

  it('keeps a lone dash and a negative number as positionals', () => {
    expect(parseArgs(['waiting', '-'], RUN).positional).toEqual(['waiting', '-'])
    expect(parseArgs(['size', '-1', '-0.5', '-2e3'], RUN).positional).toEqual([
      'size',
      '-1',
      '-0.5',
      '-2e3',
    ])
  })

  it('passes everything after -- through untouched, flags included', () => {
    const parsed = parseArgs(['--name', 'web', '--', '--cwd', '-x', '--', 'last'], RUN)
    expect(parsed.positional).toEqual(['--cwd', '-x', '--', 'last'])
    expect(parsed.values).toEqual({ name: 'web' })
  })

  describe('with unknown: keep', () => {
    const SEND = { booleans: { enter: '--enter' }, unknown: 'keep' } as const

    it('keeps unknown flags as words in the order they were written', () => {
      const parsed = parseArgs(['git', 'commit', '-m', 'fix: -1 off', '--amend', '--enter'], SEND)
      expect(parsed.positional).toEqual(['git', 'commit', '-m', 'fix: -1 off', '--amend'])
      expect(parsed.booleans.enter).toBe(true)
    })

    it('keeps a word that only starts with a dash, such as a bullet list', () => {
      expect(parseArgs(['claude', '- step one\n- step two'], SEND).positional).toEqual([
        'claude',
        '- step one\n- step two',
      ])
    })

    it('drops only the -- that ends the flags', () => {
      expect(parseArgs(['-x', '--', '--enter', '--'], SEND)).toMatchObject({
        positional: ['-x', '--enter', '--'],
        booleans: { enter: false },
      })
    })

    it('still refuses a value flag with nothing after it', () => {
      expect(
        problem(() => parseArgs(['-x', '--pane'], { values: { pane: '--pane' }, unknown: 'keep' }))
          .message,
      ).toBe('--pane needs a value')
    })
  })
})
