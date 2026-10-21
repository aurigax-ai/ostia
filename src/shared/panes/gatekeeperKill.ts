export const GATEKEEPER_WINDOW_MS = 5000

export const SIGKILL_EXIT_CODE = 137

export const DEVELOPER_TOOLS_SETTING_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools'

export interface ExitFacts {
  platform: NodeJS.Platform
  exitCode: number | undefined
  ranMs: number | undefined
}

export function maybeEndedByGatekeeper({ platform, exitCode, ranMs }: ExitFacts): boolean {
  return (
    platform === 'darwin' &&
    exitCode === SIGKILL_EXIT_CODE &&
    ranMs !== undefined &&
    ranMs >= 0 &&
    ranMs < GATEKEEPER_WINDOW_MS
  )
}

export function gatekeeperHint(product: string): string {
  const seconds = GATEKEEPER_WINDOW_MS / 1000
  return (
    `macOS Gatekeeper may have ended this process: it was killed (exit ${SIGKILL_EXIT_CODE}) within ${seconds} seconds of starting. ` +
    `If the program was just installed or upgraded, open System Settings > Privacy & Security > Developer Tools, ` +
    `turn on ${product}, then run it again. Setting: ${DEVELOPER_TOOLS_SETTING_URL}`
  )
}
