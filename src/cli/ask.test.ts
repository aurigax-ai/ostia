import { describe, expect, it } from 'vitest'
import { ASK_EXIT, askOutput, parseAskArgs } from './ask'

describe('parseAskArgs', () => {
  it('reads a free-text question', () => {
    expect(parseAskArgs(['What next?'])).toEqual({
      params: { question: 'What next?', choices: [], multi: false },
      contextFromStdin: false,
      json: false,
    })
  })

  it('collects choices in order with context, multi, timeout and json', () => {
    expect(
      parseAskArgs([
        'Which checks?',
        '--context',
        'before the release',
        '--choice',
        'lint',
        '--choice',
        'unit',
        '--multi',
        '--timeout',
        '90',
        '--json',
      ]),
    ).toEqual({
      params: {
        question: 'Which checks?',
        context: 'before the release',
        choices: ['lint', 'unit'],
        multi: true,
        timeoutSeconds: 90,
      },
      contextFromStdin: false,
      json: true,
    })
  })

  it('reads the context from stdin only for --context -', () => {
    const call = parseAskArgs(['Ship?', '--context', '-'])
    expect(call.contextFromStdin).toBe(true)
    expect(call.params.context).toBeUndefined()
    expect(parseAskArgs(['Ship?']).contextFromStdin).toBe(false)
  })

  it('joins unquoted words and takes everything after -- as the question', () => {
    expect(parseAskArgs(['Ship', 'it?']).params.question).toBe('Ship it?')
    expect(parseAskArgs(['--', '--json', 'really?']).params.question).toBe('--json really?')
  })

  it('reads flags written before the question and keeps a negative number as a word', () => {
    expect(parseAskArgs(['--json', '--choice', 'yes', 'Offset', '-5', 'ok?'])).toEqual({
      params: { question: 'Offset -5 ok?', choices: ['yes'], multi: false },
      contextFromStdin: false,
      json: true,
    })
  })

  it('refuses a missing question, multi without choices, a bad timeout and an unknown flag', () => {
    expect(() => parseAskArgs([])).toThrow(/usage: pine ask/)
    expect(() => parseAskArgs(['q', '--multi'])).toThrow(/--multi needs at least one --choice/)
    expect(() => parseAskArgs(['q', '--timeout', 'soon'])).toThrow(/--timeout expects seconds/)
    expect(() => parseAskArgs(['q', '--timeout', '0'])).toThrow(/--timeout expects seconds/)
    expect(() => parseAskArgs(['q', '--choice'])).toThrow(/--choice needs a value/)
    expect(() => parseAskArgs(['q', '--force'])).toThrow(/unknown flag --force\nusage: pine ask/)
    expect(() => parseAskArgs(['q', '--context'])).toThrow(
      /--context needs a value\nusage: pine ask/,
    )
  })
})

describe('askOutput', () => {
  it('prints the chosen labels one per line, then the reply', () => {
    expect(
      askOutput(
        { ok: true, outcome: 'answered', choices: ['lint', 'e2e'], text: 'skip unit' },
        false,
      ),
    ).toEqual({ code: 0, stdout: 'lint\ne2e\nskip unit', stderr: '' })
  })

  it('prints only the reply for a free-text answer', () => {
    expect(
      askOutput({ ok: true, outcome: 'answered', choices: [], text: 'go' }, false).stdout,
    ).toBe('go')
  })

  it('prints one JSON object with --json', () => {
    expect(
      askOutput({ ok: true, outcome: 'answered', choices: ['yes'], text: '' }, true).stdout,
    ).toBe('{"answered":true,"choices":["yes"],"text":""}')
    expect(askOutput({ ok: true, outcome: 'timeout' }, true).stdout).toBe(
      '{"answered":false,"reason":"timeout"}',
    )
  })

  it('gives each way of not being answered its own exit code and stderr line', () => {
    const dismissed = askOutput({ ok: true, outcome: 'dismissed' }, false)
    const timeout = askOutput({ ok: true, outcome: 'timeout' }, false)
    const closed = askOutput({ ok: true, outcome: 'closed' }, false)
    expect([dismissed.code, timeout.code, closed.code]).toEqual([
      ASK_EXIT.dismissed,
      ASK_EXIT.timeout,
      ASK_EXIT.closed,
    ])
    expect(new Set([0, 1, dismissed.code, timeout.code, closed.code]).size).toBe(5)
    expect(dismissed.stderr).toMatch(/dismissed/)
    expect(timeout.stderr).toMatch(/timed out/)
    expect(closed.stderr).toMatch(/pane closed/)
    expect(dismissed.stdout).toBe('')
  })

  it('reports a refused question on stderr with exit 1', () => {
    expect(
      askOutput(
        { ok: false, error: 'rate-limited', message: 'at most 6 questions a minute' },
        false,
      ),
    ).toEqual({
      code: 1,
      stdout: '',
      stderr: 'pine ask: rate-limited (at most 6 questions a minute)',
    })
  })
})
