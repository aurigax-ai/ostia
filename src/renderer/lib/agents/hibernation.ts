import { type ResumableAgent, isResumableAgent } from '@shared/agents/agentResume'

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

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIX_WORDS = new Set(['exec', 'env', 'command', 'nohup'])

export function commandAgent(command: string): ResumableAgent | null {
  for (const word of command.trim().split(/\s+/)) {
    if (!word || ENV_ASSIGNMENT.test(word) || PREFIX_WORDS.has(word)) continue
    const name = word.slice(word.lastIndexOf('/') + 1)
    return isResumableAgent(name) ? name : null
  }
  return null
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
