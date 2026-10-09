import { describe, expect, it } from 'vitest'
import { shellArgv } from '../../shared/terminal/terminalShell'
import { atLocalPrompt, busyProgram } from './localPrompt'

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

describe('busyProgram', () => {
  it('names the program that holds the terminal instead of the shell', () => {
    const fish = { foreground: '/usr/bin/sleep', shell: '/usr/bin/fish', sandboxed: false }
    expect(busyProgram(fish)).toBe('sleep')
    expect(busyProgram({ foreground: 'ssh', shell: '/bin/zsh', sandboxed: false })).toBe('ssh')
  })

  it('names nothing at the shell’s own prompt or when it cannot tell', () => {
    expect(busyProgram({ foreground: 'fish', shell: '/usr/bin/fish', sandboxed: false })).toBeNull()
    expect(busyProgram({ foreground: 'sleep', shell: '/bin/sh', sandboxed: true })).toBeNull()
    expect(busyProgram({ foreground: '', shell: '/bin/zsh', sandboxed: false })).toBeNull()
  })

  it('quitting with an idle shell without blocks shows no dialog', () => {
    const [shell] = shellArgv('/bin/sh -i', '/bin/zsh')
    expect(busyProgram({ foreground: 'sh', shell, sandboxed: false })).toBeNull()
  })
})
