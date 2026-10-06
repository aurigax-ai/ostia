import { describe, expect, it } from 'vitest'
import { TMUX_MISSING, keepShellsNotice } from './keepShellsBanner'

describe('keepShellsNotice', () => {
  it('KSH-C63 says why the shell is not kept and that it will not survive a restart', () => {
    const notice = keepShellsNotice(TMUX_MISSING)
    expect(notice).toContain('tmux 3.2 or newer is not installed')
    expect(notice).toContain('This shell will not survive a restart.')
    expect(notice).not.toContain('No shell was started')
  })

  it('keeps a multi-line reason on one line and drops control characters', () => {
    const notice = keepShellsNotice('tmux could not start its server: line one\n\x1b]0;x\x07two')
    expect(notice).toContain('tmux could not start its server: line one ]0;x two.')
    expect(notice.split('\x1b').length - 1).toBe(2)
  })
})
