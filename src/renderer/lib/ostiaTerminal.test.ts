import type { Terminal as Xterm } from '@xterm/xterm'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type OstiaTerminal, terminalScreen } from './ostiaTerminal'

describe('OstiaTerminal', () => {
  it('is satisfied by xterm.js as it is', () => {
    expectTypeOf<Xterm>().toMatchTypeOf<OstiaTerminal>()
  })

  it('finds the screen of either engine', () => {
    for (const name of ['xterm-screen', 'ghostty-screen']) {
      const host = document.createElement('div')
      host.innerHTML = `<div><canvas class="${name}"></canvas></div>`
      expect(terminalScreen(host)?.className).toBe(name)
    }
    expect(terminalScreen(document.createElement('div'))).toBeNull()
  })
})
