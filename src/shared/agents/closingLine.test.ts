import { describe, expect, it } from 'vitest'
import { closingFromStop, closingLine, STATUS_MESSAGE_MAX } from './closingLine'

describe('closingLine', () => {
  it('takes the first line with text, on one line, without escape sequences', () => {
    expect(closingLine('\n\n  PR #12   open \x1b[31m, tests green\x07\nlong report follows')).toBe(
      'PR #12 open [31m, tests green',
    )
  })

  it('clips a long line to the status cap with an ellipsis', () => {
    const line = closingLine('x'.repeat(1000))
    expect(line).toHaveLength(STATUS_MESSAGE_MAX)
    expect(line?.endsWith('…')).toBe(true)
  })

  it('is undefined for anything that holds no printable text', () => {
    expect(closingLine(undefined)).toBeUndefined()
    expect(closingLine(42)).toBeUndefined()
    expect(closingLine(' \n\x1b\x07 ')).toBeUndefined()
  })
})

describe('closingFromStop', () => {
  it('reads the closing line out of a Stop hook payload', () => {
    const raw = JSON.stringify({
      session_id: 's-1',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done: PR #7 is up.\nDetails below.',
    })
    expect(closingFromStop(raw)).toBe('Done: PR #7 is up.')
  })

  it('is undefined for a payload without a message, a bad session id or text that is not JSON', () => {
    expect(closingFromStop(JSON.stringify({ session_id: 's-1' }))).toBeUndefined()
    expect(
      closingFromStop(JSON.stringify({ session_id: '', last_assistant_message: 'hi' })),
    ).toBeUndefined()
    expect(closingFromStop('not json')).toBeUndefined()
  })
})
