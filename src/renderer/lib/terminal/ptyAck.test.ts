import { PTY_ACK_CHARS } from '@shared/terminal/ptyFlow'
import { describe, expect, it } from 'vitest'
import { createPtyAcker } from './ptyAck'

describe('createPtyAcker', () => {
  it('acknowledges written characters in batches of at least PTY_ACK_CHARS', () => {
    const acks: number[] = []
    const acker = createPtyAcker((chars) => acks.push(chars))
    acker.written(PTY_ACK_CHARS - 1)
    expect(acks).toEqual([])
    acker.written(3)
    expect(acks).toEqual([PTY_ACK_CHARS + 2])
    acker.written(PTY_ACK_CHARS * 3)
    expect(acks).toEqual([PTY_ACK_CHARS + 2, PTY_ACK_CHARS * 3])
  })
})
