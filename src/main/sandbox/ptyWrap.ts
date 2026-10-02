import { readFileSync } from 'node:fs'
import { quoteArg } from '../../shared/shellQuote'

const LEGACY_TIOCSTI = '/proc/sys/dev/tty/legacy_tiocsti'
const NEW_SESSION = ' --new-session --die-with-parent '
const OUTER_TERMIOS = 'PINE_RELAY_TTY'
const RELAY_SHELL = '/bin/sh'

export const PTY_RELAY_ENV = 'PINE_SANDBOX_PTY_RELAY'

export function terminalInjectionOff(read: (path: string) => string = readProc): boolean {
  try {
    return read(LEGACY_TIOCSTI).trim() === '0'
  } catch {
    return false
  }
}

function readProc(path: string): string {
  return readFileSync(path, 'utf8')
}

export function relayForced(isPackaged: boolean, env: Record<string, string | undefined>): boolean {
  return !isPackaged && env[PTY_RELAY_ENV] === '1'
}

export function needsPtyRelay(
  forced: boolean,
  read: (path: string) => string = readProc,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' && (forced || !terminalInjectionOff(read))
}

function relayedShell(shellCommand: string, shellEnv: string | undefined): string {
  return [
    `stty "$${OUTER_TERMIOS}" 2>/dev/null`,
    `unset ${OUTER_TERMIOS}`,
    shellEnv === undefined ? 'unset SHELL' : `export SHELL=${quoteArg(shellEnv)}`,
    `exec ${shellCommand}`,
  ].join('; ')
}

export function sandboxedShellCommand(
  shellCommand: string,
  shellEnv: string | undefined,
  resizePipe: string | null,
  portBridge: string | null = null,
): string {
  const helpers = portBridge ? [portBridge] : []
  if (!resizePipe) {
    return helpers.length === 0 ? shellCommand : [...helpers, `exec ${shellCommand}`].join('\n')
  }
  return [
    ...helpers,
    `{ while read -r -n1 _; do kill -WINCH 0 2>/dev/null; done <>${quoteArg(resizePipe)}; } &`,
    `SHELL=${RELAY_SHELL} script -qec ${quoteArg(relayedShell(shellCommand, shellEnv))} /dev/null`,
    'exit $?',
  ].join('\n')
}

const FORWARD_RESIZE = [
  '(',
  `trap 'printf . 1<>"$f"' WINCH;`,
  'sleep infinity & s=$!;',
  `trap 'kill "$s" 2>/dev/null' TERM;`,
  'while kill -0 "$s" 2>/dev/null; do wait "$s"; done',
  ') &',
].join(' ')

function relayWrapper(wrapped: string, resizePipe: string): string {
  return [
    `f=${quoteArg(resizePipe)}`,
    'rm -f "$f"',
    'mkfifo -m 600 "$f" || exit 1',
    `${OUTER_TERMIOS}=$(stty -g) || exit 1`,
    `export ${OUTER_TERMIOS}`,
    'stty -isig -icanon -echo',
    FORWARD_RESIZE,
    'w=$!',
    wrapped,
    'rc=$?',
    'kill "$w" 2>/dev/null',
    'rm -f "$f"',
    'exit "$rc"',
  ].join('\n')
}

export function wrapForTerminal(
  wrapped: string,
  resizePipe: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'linux') return wrapped
  if (resizePipe) return relayWrapper(wrapped, resizePipe)
  return wrapped.replace(NEW_SESSION, ' --die-with-parent ')
}
