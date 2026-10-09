import { readFileSync } from 'node:fs'

const LEGACY_TIOCSTI = '/proc/sys/dev/tty/legacy_tiocsti'

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

export function needsPtyRelay(
  forced: boolean,
  read: (path: string) => string = readProc,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' && (forced || !terminalInjectionOff(read))
}
