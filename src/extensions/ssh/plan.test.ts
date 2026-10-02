import { describe, expect, it } from 'vitest'
import { planConnect, withShellIntegration } from './plan'
import { REMOTE_COMMAND } from './remote'

describe('planConnect', () => {
  it('SSH-C10 builds the same ssh argv from CLI arguments and from one palette string', () => {
    const expected = {
      destination: 'dev@db',
      jump: ['b1', 'ops@b2:2222'],
      port: 2200,
      argv: ['ssh', '-J', 'b1,ops@b2:2222', '-p', '2200', '--', 'dev@db'],
      command: 'ssh -J b1,ops@b2:2222 -p 2200 -- dev@db',
      shellIntegration: false,
    }
    expect(planConnect(['-J', 'b1,ops@b2:2222', '-p', '2200', 'dev@db'])).toEqual(expected)
    expect(planConnect(['  -J b1,ops@b2:2222   -p 2200 dev@db '])).toEqual(expected)
    expect(planConnect(['dev@db', '-p', '2200', '-J', 'b1,ops@b2:2222'])).toEqual(expected)
    expect(planConnect(['db'])).toEqual({
      destination: 'db',
      jump: [],
      argv: ['ssh', '--', 'db'],
      command: 'ssh -- db',
      shellIntegration: false,
    })
  })
})

describe('withShellIntegration', () => {
  it('SSH-C28 adds only -t before the separator and the fixed remote command after the destination', () => {
    const plain = planConnect(['-J', 'b1', '-p', '2200', 'dev@db'])
    if (!plain) throw new Error('planned')
    expect(withShellIntegration(plain)).toEqual({
      destination: 'dev@db',
      jump: ['b1'],
      port: 2200,
      argv: ['ssh', '-J', 'b1', '-p', '2200', '-t', '--', 'dev@db', REMOTE_COMMAND],
      command: 'ssh -J b1 -p 2200 -t -- dev@db',
      shellIntegration: true,
    })
  })

  it('SSH-C28 sends the same remote command whatever host, user, port or hops were asked for', () => {
    const remoteOf = (argv: string[]): string | undefined => {
      const plan = planConnect(argv)
      return plan ? withShellIntegration(plan).argv.at(-1) : undefined
    }
    expect(remoteOf(['db'])).toBe(REMOTE_COMMAND)
    expect(remoteOf(['-J', 'a,b:22', '-p', '9', 'x@y'])).toBe(REMOTE_COMMAND)
  })
})
