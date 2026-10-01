import { describe, expect, it } from 'vitest'
import { planConnect } from './plan'

describe('planConnect', () => {
  it('SSH-C10 builds the same ssh argv from CLI arguments and from one palette string', () => {
    const expected = {
      destination: 'dev@db',
      jump: ['b1', 'ops@b2:2222'],
      port: 2200,
      argv: ['ssh', '-J', 'b1,ops@b2:2222', '-p', '2200', '--', 'dev@db'],
      command: 'ssh -J b1,ops@b2:2222 -p 2200 -- dev@db',
    }
    expect(planConnect(['-J', 'b1,ops@b2:2222', '-p', '2200', 'dev@db'])).toEqual(expected)
    expect(planConnect(['  -J b1,ops@b2:2222   -p 2200 dev@db '])).toEqual(expected)
    expect(planConnect(['dev@db', '-p', '2200', '-J', 'b1,ops@b2:2222'])).toEqual(expected)
    expect(planConnect(['db'])).toEqual({
      destination: 'db',
      jump: [],
      argv: ['ssh', '--', 'db'],
      command: 'ssh -- db',
    })
  })
})
