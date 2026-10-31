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

  it('REM-U8 refuses a pane id that is not eight hex digits', () => {
    expect(() => attachArgv(plan, '$(touch x)', messages)).toThrow('bad pane id')
  })
})
