import { describe, expect, it } from 'vitest'
import {
  PTY_RELAY_ENV,
  needsPtyRelay,
  relayForced,
  sandboxedShellCommand,
  terminalInjectionOff,
  wrapForTerminal,
} from './ptyWrap'

const WRAPPED = "bwrap --new-session --die-with-parent --dev /dev -- bash -c 'zsh -i'"
const PIPE = '/tmp/pine-sandbox-tmp/1/ws/resize-abc'
const refuses = (): string => '0\n'
const allows = (): string => '1\n'
const unreadable = (): string => {
  throw new Error('ENOENT')
}

describe('terminalInjectionOff', () => {
  it('is true only when the kernel refuses TIOCSTI', () => {
    expect(terminalInjectionOff(refuses)).toBe(true)
    expect(terminalInjectionOff(allows)).toBe(false)
    expect(terminalInjectionOff(unreadable)).toBe(false)
  })
})

describe('relayForced', () => {
  it('honours the switch only in an unpackaged build', () => {
    expect(relayForced(false, { [PTY_RELAY_ENV]: '1' })).toBe(true)
    expect(relayForced(true, { [PTY_RELAY_ENV]: '1' })).toBe(false)
    expect(relayForced(false, {})).toBe(false)
    expect(relayForced(false, { [PTY_RELAY_ENV]: '0' })).toBe(false)
  })
})

describe('needsPtyRelay', () => {
  it('relays on Linux wherever keys could be injected into the pane’s terminal', () => {
    expect(needsPtyRelay(false, allows, 'linux')).toBe(true)
    expect(needsPtyRelay(false, unreadable, 'linux')).toBe(true)
    expect(needsPtyRelay(false, refuses, 'linux')).toBe(false)
  })

  it('relays when forced, whatever the kernel says', () => {
    expect(needsPtyRelay(true, refuses, 'linux')).toBe(true)
  })

  it('never relays on another platform', () => {
    expect(needsPtyRelay(true, allows, 'darwin')).toBe(false)
  })
})

describe('sandboxedShellCommand', () => {
  it('runs the shell as it is when the pane’s terminal is its own', () => {
    expect(sandboxedShellCommand('/usr/bin/zsh -i', '/usr/bin/zsh', null)).toBe('/usr/bin/zsh -i')
  })

  it('runs the shell on an inner terminal that script relays, with the pane’s terminal settings and SHELL', () => {
    const command = sandboxedShellCommand("/usr/bin/zsh -i 'a b'", '/usr/bin/zsh', PIPE)
    expect(command.split('\n')).toEqual([
      `{ while read -r -n1 _; do kill -WINCH 0 2>/dev/null; done <>${PIPE}; } &`,
      `SHELL=/bin/sh script -qec 'stty "$PINE_RELAY_TTY" 2>/dev/null; unset PINE_RELAY_TTY; export SHELL=/usr/bin/zsh; exec /usr/bin/zsh -i '\\''a b'\\''' /dev/null`,
      'exit $?',
    ])
  })

  it('leaves SHELL unset inside when the pane had none', () => {
    expect(sandboxedShellCommand('bash -i', undefined, PIPE)).toContain(
      '; unset SHELL; exec bash -i',
    )
  })

  it('quotes a resize pipe path that holds spaces', () => {
    expect(sandboxedShellCommand('bash -i', '/bin/bash', '/tmp/my ws/resize-1')).toContain(
      "done <>'/tmp/my ws/resize-1'; } &",
    )
  })
})

describe('wrapForTerminal', () => {
  it('keeps the shell on the pane’s terminal when nothing can inject keys into it', () => {
    expect(wrapForTerminal(WRAPPED, null, 'linux')).toBe(
      "bwrap --die-with-parent --dev /dev -- bash -c 'zsh -i'",
    )
  })

  it('removes only bwrap’s own flag, never the same words inside the command', () => {
    const inner =
      "bwrap --new-session --die-with-parent -- bash -c 'echo --new-session --die-with-parent x'"
    expect(wrapForTerminal(inner, null, 'linux')).toBe(
      "bwrap --die-with-parent -- bash -c 'echo --new-session --die-with-parent x'",
    )
  })

  it('keeps the new session behind the relay and forwards window changes through the pipe', () => {
    const lines = wrapForTerminal(WRAPPED, PIPE, 'linux').split('\n')
    expect(lines).toContain(WRAPPED)
    expect(lines.slice(0, lines.indexOf(WRAPPED))).toEqual([
      `f=${PIPE}`,
      'rm -f "$f"',
      'mkfifo -m 600 "$f" || exit 1',
      'PINE_RELAY_TTY=$(stty -g) || exit 1',
      'export PINE_RELAY_TTY',
      'stty -isig -icanon -echo',
      `( trap 'printf . 1<>"$f"' WINCH; sleep infinity & s=$!; trap 'kill "$s" 2>/dev/null' TERM; while kill -0 "$s" 2>/dev/null; do wait "$s"; done ) &`,
      'w=$!',
    ])
    expect(lines.slice(lines.indexOf(WRAPPED) + 1)).toEqual([
      'rc=$?',
      'kill "$w" 2>/dev/null',
      'rm -f "$f"',
      'exit "$rc"',
    ])
  })

  it('never ignores the interrupt keys in the wrapper, which the shell’s commands would inherit', () => {
    expect(wrapForTerminal(WRAPPED, PIPE, 'linux')).not.toMatch(/trap '' /)
  })

  it('leaves another platform’s wrapper untouched', () => {
    expect(wrapForTerminal('sandbox-exec -p x zsh', null, 'darwin')).toBe('sandbox-exec -p x zsh')
    expect(wrapForTerminal('sandbox-exec -p x zsh', PIPE, 'darwin')).toBe('sandbox-exec -p x zsh')
  })
})
