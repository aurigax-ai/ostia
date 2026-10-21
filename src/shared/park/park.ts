import type { AgentBusyReason } from '../agents/agentWork'

export const PARKED_PANEL_EXTENSION_ID = 'activity'
export const PARK_SUMMARY_MAX = 160
export const PARKED_PER_WORKSPACE_MAX = 25

export type ParkRefusal =
  | AgentBusyReason
  | 'working'
  | 'locked'
  | 'manager'
  | 'scratch'
  | 'sandboxed'
  | 'remote'
  | 'no-agent'
  | 'no-session'
  | 'too-many'
  | 'workspace-closed'
  | 'unavailable'

export interface ParkFacts {
  manager: boolean
  workspaceKind: string
  sandboxed: boolean
  remote: boolean
  locked: boolean
  agentRunning: boolean
  hasResume: boolean
  working: boolean
}

export function parkRefusal(facts: ParkFacts): ParkRefusal | null {
  if (facts.manager || facts.workspaceKind === 'manager') return 'manager'
  if (facts.workspaceKind === 'scratch') return 'scratch'
  if (facts.sandboxed) return 'sandboxed'
  if (facts.remote) return 'remote'
  if (facts.locked) return 'locked'
  if (!facts.agentRunning) return 'no-agent'
  if (!facts.hasResume) return 'no-session'
  if (facts.working) return 'working'
  return null
}

export type ParkOutcome =
  | { ok: true; id: string; title: string }
  | { ok: false; reason: ParkRefusal }

export function singleLine(text: string, max: number): string {
  const one = [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f ? ' ' : ch
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...one]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one
}
