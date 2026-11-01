import { describe, expect, it } from 'vitest'
import { terminalScreen } from './ostiaTerminal'

describe('OstiaTerminal', () => {
  it('finds the screen of the terminal', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div><canvas class="ghostty-screen"></canvas></div>'
    expect(terminalScreen(host)?.className).toBe('ghostty-screen')
    expect(terminalScreen(document.createElement('div'))).toBeNull()
  })
})
