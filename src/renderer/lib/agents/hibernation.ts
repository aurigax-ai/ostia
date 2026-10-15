export interface HibernationPolicy {
  idleSeconds: number
  maxLiveTerminals: number
}

export interface HibernationCandidate {
  paneId: string
  workspaceId: string
  agentRunning: boolean
  visible: boolean
  idleMs: number
}

export interface HibernationPlan {
  excess: number
  longestIdleFirst: HibernationCandidate[]
}

export function planHibernation(
  candidates: HibernationCandidate[],
  policy: HibernationPolicy,
): HibernationPlan {
  const live = candidates.filter((c) => c.agentRunning)
  const excess = Math.max(0, live.length - policy.maxLiveTerminals)
  if (excess === 0) return { excess, longestIdleFirst: [] }
  const idleMs = policy.idleSeconds * 1000
  return {
    excess,
    longestIdleFirst: live
      .filter((c) => !c.visible && c.idleMs >= idleMs)
      .sort((a, b) => b.idleMs - a.idleMs),
  }
}
