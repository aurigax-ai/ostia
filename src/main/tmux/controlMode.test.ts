import { describe, expect, it } from 'vitest'
import { type ControlEvent, ControlModeParser } from './controlMode'

function parse(...chunks: Buffer[]): ControlEvent[] {
  const events: ControlEvent[] = []
  const parser = new ControlModeParser((e) => events.push(e))
  for (const chunk of chunks) parser.push(chunk)
  return events
}

describe('ControlModeParser', () => {
  it('KSH-C29 gives a pane the exact bytes behind octal escapes and a UTF-8 character split across lines', () => {
    const events = parse(
      Buffer.from('%output %1 a\\011b\\134\\033[0m'),
      Buffer.concat([Buffer.from('\n%output %1 x'), Buffer.from([0xe2, 0x82])]),
      Buffer.concat([Buffer.from('\n%output %1 '), Buffer.from([0xac]), Buffer.from('!\n')]),
    )
    const text = events
      .filter((e) => e.type === 'output')
      .map((e) => (e.type === 'output' ? e.data : ''))
      .join('')
    expect(text).toBe('a\tb\\\x1b[0mx€!')
    expect(events.every((e) => e.type !== 'output' || e.pane === '%1')).toBe(true)
  })

  it('collects a command reply between %begin and %end and an error between %begin and %error', () => {
    const events = parse(
      Buffer.from('%begin 1 2 0\n%end 1 2 0\n%begin 1 3 1\n@1 %1 4242\n%end 1 3 1\n'),
      Buffer.from('%begin 1 4 1\nno such window: @9\n%error 1 4 1\n%exit\n'),
    )
    expect(events).toEqual([
      { type: 'reply', ok: true, lines: ['@1 %1 4242'] },
      { type: 'reply', ok: false, lines: ['no such window: @9'] },
      { type: 'exit' },
    ])
  })

  it('reports a subscription change with its pane and value', () => {
    expect(parse(Buffer.from('%subscription-changed ostia-dead $0 @1 1 %1 : 1:7:\n'))).toEqual([
      { type: 'subscription', name: 'ostia-dead', pane: '%1', value: '1:7:' },
    ])
  })
})
