import { describe, expect, it } from 'vitest'
import { planConnect } from '../plan'
import { attachArgv } from './attach'

const messages = { disconnected: 'lost', failed: 'never connected' }

describe('attachArgv', () => {
  const plan = planConnect(['box'])
  if (!plan) throw new Error('no plan')

  it('REM-U7 gives a terminal command with no control characters, which the terminal opener demands', () => {
    for (const arg of attachArgv(plan, '0123abcd', messages)) {
      expect([...arg].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)).toBe(
        false,
      )
    }
  })

  it('REM-U44 holds the first-connect failure on screen until Enter, because the pane closes after it', () => {
    const loop = attachArgv(plan, '0123abcd', messages)[2]
    const failed = loop.slice(loop.indexOf('"$connected" = 0'))
    expect(failed.indexOf('read -r _')).toBeGreaterThan(failed.indexOf('"$failed"'))
    expect(failed.indexOf('exit 255')).toBeGreaterThan(failed.indexOf('read -r _'))
  })

  it('REM-U47 ends the tab with its session, so it never moves to another job on the host', () => {
    const remote = attachArgv(plan, '0123abcd', messages).at(-1)
    expect(remote).toContain('set-option -t "=0123abcd:" detach-on-destroy on \\; attach')
  })

  it('REM-U8 refuses a pane id that is not eight hex digits', () => {
    expect(() => attachArgv(plan, '$(touch x)', messages)).toThrow('bad pane id')
  })
})
