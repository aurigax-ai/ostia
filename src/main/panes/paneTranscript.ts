import { type AgentResume, isResumableAgent } from '../../shared/agents/agentResume'
import { claudeTurns, codexTurns, renderTurns } from '../../shared/agents/transcriptTurns'
import { registerControlMethod } from '../control/controlServer'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import type { PaneEntry } from './paneList'
import { type PaneReachDeps, ensurePaneReach, fail, paneTarget, record } from './paneReach'

const TRANSCRIPT_TURNS_MAX = 50
const TAIL_BYTES = 4 * 1024 * 1024
const FULL_BYTES = 32 * 1024 * 1024

export interface PaneTranscriptDeps extends PaneReachDeps {
  panes: () => Promise<PaneEntry[]>
  lines: (resume: AgentResume, bytes: number) => string[] | null
}

function turnsParam(raw: unknown): number {
  if (raw === undefined) return 1
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > TRANSCRIPT_TURNS_MAX) {
    throw fail(`bad-request: turns (1-${TRANSCRIPT_TURNS_MAX})`)
  }
  return raw
}

export function registerPaneTranscriptMethods(deps: PaneTranscriptDeps): void {
  registerControlMethod('pane.transcript', {
    handler: async (raw, ctx) => {
      const p = record(raw)
      if (p.full !== undefined && typeof p.full !== 'boolean') throw fail('bad-request: full')
      if (p.full === true && p.turns !== undefined) throw fail('bad-request: turns with full')
      const turns = turnsParam(p.turns)
      if (deps.isSandboxed(ctx.identity.workspaceId)) throw fail(SANDBOXED_REFUSAL)
      const to = await paneTarget(deps, p.pane, ctx)
      await ensurePaneReach(deps, 'read', to, ctx, {
        ref: String(p.pane),
        method: 'pane.transcript',
        detail: `the transcript of ${to.externalId}`,
      })
      const entry = (await deps.panes()).find((item) => item.paneId === to.externalId)
      if (!entry?.agentSessionId || !isResumableAgent(entry.agent)) {
        throw fail('no-transcript: no agent session is known for that pane')
      }
      const resume: AgentResume = { agent: entry.agent, id: entry.agentSessionId }
      const lines = deps.lines(resume, p.full === true ? FULL_BYTES : TAIL_BYTES)
      if (!lines) throw fail('no-transcript: the agent has no transcript file yet')
      const all = resume.agent === 'claude' ? claudeTurns(lines) : codexTurns(lines)
      const shown = p.full === true ? all : all.slice(-turns)
      return { agent: resume.agent, turns: shown.length, text: renderTurns(shown) }
    },
  })
}
