import { type AgentResume, isResumableAgent } from '../../shared/agents/agentResume'
import { claudeTurns, codexTurns, renderTurns } from '../../shared/agents/transcriptTurns'
import type { TailRead } from '../agents/transcriptFiles'
import { registerControlMethod } from '../control/controlServer'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import type { PaneEntry } from './paneList'
import { ensurePaneReach, fail, type PaneReachDeps, paneTarget, record } from './paneReach'

const TRANSCRIPT_TURNS_MAX = 50
const TAIL_BYTES = 4 * 1024 * 1024
const FULL_BYTES = 32 * 1024 * 1024
const WIDEN = 4

export interface PaneTranscriptDeps extends PaneReachDeps {
  panes: () => Promise<PaneEntry[]>
  lines: (resume: AgentResume, bytes: number) => Promise<TailRead | null>
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
      const full = p.full === true
      const parse = resume.agent === 'claude' ? claudeTurns : codexTurns
      let bytes = full ? FULL_BYTES : TAIL_BYTES
      for (;;) {
        const read = await deps.lines(resume, bytes)
        if (!read) throw fail('no-transcript: the agent has no transcript file yet')
        const all = parse(read.lines)
        const enough = full || all.length >= turns || !read.truncated
        if (!enough && bytes < FULL_BYTES) {
          bytes = Math.min(bytes * WIDEN, FULL_BYTES)
          continue
        }
        if (all.length === 0 && read.truncated) {
          throw fail(`too-large: the last turn is bigger than ${FULL_BYTES / (1024 * 1024)} MiB`)
        }
        const shown = full ? all : all.slice(-turns)
        const cut = read.truncated && (full || all.length < turns)
        return {
          agent: resume.agent,
          turns: shown.length,
          text: renderTurns(shown),
          ...(cut ? { truncated: true as const } : {}),
        }
      }
    },
  })
}
