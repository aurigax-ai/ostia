import { describe, expect, it } from 'vitest'
import { atLocalPrompt } from './localPrompt'

describe('atLocalPrompt', () => {
  it('is true while the pane’s own shell holds the terminal', () => {
    expect(atLocalPrompt({ foreground: 'zsh', shell: '/usr/bin/zsh', sandboxed: false })).toBe(true)
    expect(atLocalPrompt({ foreground: '-zsh', shell: '/bin/zsh', sandboxed: false })).toBe(true)
  })

  it('is false while another program holds it, such as ssh showing a remote prompt', () => {
    expect(atLocalPrompt({ foreground: 'ssh', shell: '/usr/bin/zsh', sandboxed: false })).toBe(
      false,
    )
    expect(atLocalPrompt({ foreground: 'docker', shell: '/bin/bash', sandboxed: false })).toBe(
      false,
    )
  })

  it('does not guess when the shell runs wrapped or the name is unknown', () => {
    expect(atLocalPrompt({ foreground: 'bwrap', shell: '/bin/sh', sandboxed: true })).toBe(true)
    expect(atLocalPrompt({ foreground: '', shell: '/usr/bin/zsh', sandboxed: false })).toBe(true)
    expect(atLocalPrompt({ foreground: 'zsh', shell: '', sandboxed: false })).toBe(true)
  })
})
