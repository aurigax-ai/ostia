import type { AgentResume, ResumableAgent } from '@shared/agents/agentResume'
import type { AttentionState } from '@shared/attention/attention'
import type { PaneAttention } from '@/lib/attention/attention'
import type { PaneNode } from '@/lib/layout/types'
import type { CommandBlock } from '@/stores/terminal/blocksStore'

export interface AgentSession {
  agent: ResumableAgent
  title: string | null
  resume: AgentResume | null
  command: string
  cwd: string | null
  startedAt: number
  state: AttentionState
  message: string | null
}

const TITLE_DECORATION = /^[^\p{L}\p{N}]+/u
const SHELL_TITLES = new Set(['zsh', 'bash', 'sh', 'fish'])

export function sessionTitle(title: string, agent: ResumableAgent): string | null {
  const clean = title.replace(TITLE_DECORATION, '').trim()
  if (!clean) return null
  const lower = clean.toLowerCase()
  if (lower === agent || lower.startsWith(`${agent} `) || SHELL_TITLES.has(lower)) return null
  return clean
}

export function agentSession(
  pane: PaneNode,
  running: CommandBlock | undefined,
  attention: PaneAttention | undefined,
  agent: ResumableAgent | null,
): AgentSession | null {
  if (pane.kind !== 'terminal' || !running || !agent) return null
  return {
    agent,
    title: pane.defaultTitle ? null : sessionTitle(pane.title, agent),
    resume: pane.resume?.agent === agent ? pane.resume : null,
    command: running.command,
    cwd: running.cwd,
    startedAt: running.startedAt,
    state: attention?.state ?? 'none',
    message: attention?.message ?? null,
  }
}
