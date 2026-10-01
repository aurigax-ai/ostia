export const STARTUP_FAILURE_MS = 3_000

export interface ShellExit {
  ownExit: boolean
  code: number
  livedMs: number
}

export function closesPaneOnExit({ ownExit, code, livedMs }: ShellExit): boolean {
  if (!ownExit) return false
  return code === 0 || livedMs >= STARTUP_FAILURE_MS
}
