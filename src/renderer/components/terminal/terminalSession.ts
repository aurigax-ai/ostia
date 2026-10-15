import type { TerminalMarker } from '@/lib/terminal/ostiaTerminal'

export interface TerminalSession {
  disposed: boolean
  replaying: boolean
  cwd: string | null
  remote: boolean
  promptMarker: TerminalMarker | undefined
}

export function createTerminalSession(cwd: string | null): TerminalSession {
  return { disposed: false, replaying: false, cwd, remote: false, promptMarker: undefined }
}
