export const UNATTENDED_QUIT_DEADLINE_MS = 5000

export type QuitPlan = 'proceed' | 'ask' | 'unattended'

export interface QuitState {
  approved: boolean
  requestedByOstia: boolean
  platform: NodeJS.Platform
}

export function planQuit(state: QuitState): QuitPlan {
  if (state.approved) return 'proceed'
  if (state.requestedByOstia || state.platform === 'darwin') return 'ask'
  return 'unattended'
}

export function exitAfterDeadline(
  exit: () => void,
  deadlineMs = UNATTENDED_QUIT_DEADLINE_MS,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(exit, deadlineMs)
  timer.unref?.()
  return timer
}
