export const REACH_MODES = ['workspace', 'project', 'group'] as const
export type ReachMode = (typeof REACH_MODES)[number]

export const DEFAULT_REACH_MODE: ReachMode = 'project'

export function isReachMode(raw: unknown): raw is ReachMode {
  return REACH_MODES.includes(raw as ReachMode)
}

export function parseReachMode(raw: unknown): ReachMode {
  return isReachMode(raw) ? raw : DEFAULT_REACH_MODE
}
