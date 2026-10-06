import { describe, expect, it } from 'vitest'
import { tmuxConf } from './tmuxConf'

describe('tmuxConf', () => {
  it('KSH-C68 leaves window-size alone: a global manual size crashes tmux before 3.7 on a new window', () => {
    expect(tmuxConf('screen-256color')).not.toContain('window-size')
  })

  it('names the terminal type it was given', () => {
    expect(tmuxConf('tmux-256color')).toContain('set -g default-terminal "tmux-256color"')
  })
})
