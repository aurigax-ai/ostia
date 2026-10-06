import { describe, expect, it } from 'vitest'
import { KEPT_AGENT_UNREPORTED, KeptAttention } from './keptAttention'

describe('KeptAttention', () => {
  it('KSH-C67 treats a reattached pane whose agent kept running as waiting until it reports', () => {
    const attention = new KeptAttention()
    attention.reattached('a', true)
    expect(attention.peek('a')).toEqual({ state: 'waiting', message: KEPT_AGENT_UNREPORTED })
    attention.reported('a')
    expect(attention.peek('a')).toBeUndefined()
  })

  it('leaves a reattached pane without a running agent alone', () => {
    const attention = new KeptAttention()
    attention.reattached('a', false)
    expect(attention.peek('a')).toBeUndefined()
  })

  it('forgets an old mark when the pane is reattached again without an agent', () => {
    const attention = new KeptAttention()
    attention.reattached('a', true)
    attention.reattached('a', false)
    expect(attention.peek('a')).toBeUndefined()
  })
})
