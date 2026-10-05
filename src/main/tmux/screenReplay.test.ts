import { describe, expect, it } from 'vitest'
import { screenReplay } from './screenReplay'

describe('screenReplay', () => {
  it('writes history and screen, then puts the cursor back where the program left it', () => {
    expect(screenReplay('0 4 1 1 0 0 0 0 0 0', ['$ ls', 'a  b', '$ '], null)).toBe(
      '$ ls\x1b[0m\r\na  b\x1b[0m\r\n$ \x1b[0m\x1b[2;5H',
    )
  })

  it('KSH-C12 brings a full-screen program back on the alternate screen with its key modes', () => {
    const replay = screenReplay('1 9 0 1 1 1 0 0 1 1', ['normal1'], ['ALTSCREEN', ''])
    expect(replay).toBe(
      'normal1\x1b[0m\x1b[?1049h\x1b[H\x1b[2JALTSCREEN\x1b[0m\r\n\x1b[0m\x1b[1;10H\x1b[?1h\x1b=\x1b[?1003h\x1b[?1006h',
    )
  })

  it('hides the cursor when the program hid it', () => {
    expect(screenReplay('0 0 0 0 0 0 0 0 0 0', [''], null)).toContain('\x1b[?25l')
  })
})
