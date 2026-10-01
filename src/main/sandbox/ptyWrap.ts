import { readFileSync } from 'node:fs'

const LEGACY_TIOCSTI = '/proc/sys/dev/tty/legacy_tiocsti'
const NEW_SESSION = ' --new-session --die-with-parent '
const KEEP_WRAPPER_ALIVE = "trap '' INT QUIT TSTP; "

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

export function wrapForTerminal(
  wrapped: string,
  injectionOff: boolean,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'linux' || !wrapped.includes(NEW_SESSION)) return wrapped
  if (injectionOff) return wrapped.replace(NEW_SESSION, ' --die-with-parent ')
  return `${KEEP_WRAPPER_ALIVE}${wrapped}`
}
