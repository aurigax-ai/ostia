import { describe, expect, it } from 'vitest'
import { terminalInjectionOff, wrapForTerminal } from './ptyWrap'

const WRAPPED = "bwrap --new-session --die-with-parent --dev /dev -- bash -c 'zsh -i'"

describe('terminalInjectionOff', () => {
  it('is true only when the kernel refuses TIOCSTI', () => {
    expect(terminalInjectionOff(() => '0\n')).toBe(true)
    expect(terminalInjectionOff(() => '1\n')).toBe(false)
    expect(
      terminalInjectionOff(() => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })
})

describe('wrapForTerminal', () => {
  it('keeps the shell on the pane’s terminal when nothing can inject keys into it', () => {
    expect(wrapForTerminal(WRAPPED, true, 'linux')).toBe(
      "bwrap --die-with-parent --dev /dev -- bash -c 'zsh -i'",
    )
  })

  it('keeps the new session where keys could be injected, and stops Ctrl+C killing the wrapper', () => {
    expect(wrapForTerminal(WRAPPED, false, 'linux')).toBe(`trap '' INT QUIT TSTP; ${WRAPPED}`)
  })

  it('removes only bwrap’s own flag, never the same words inside the command', () => {
    const inner =
      "bwrap --new-session --die-with-parent -- bash -c 'echo --new-session --die-with-parent x'"
    expect(wrapForTerminal(inner, true, 'linux')).toBe(
      "bwrap --die-with-parent -- bash -c 'echo --new-session --die-with-parent x'",
    )
  })

  it('leaves another platform’s wrapper untouched', () => {
    expect(wrapForTerminal('sandbox-exec -p x zsh', true, 'darwin')).toBe('sandbox-exec -p x zsh')
    expect(wrapForTerminal('sandbox-exec -p x zsh', false, 'darwin')).toBe('sandbox-exec -p x zsh')
  })
})
