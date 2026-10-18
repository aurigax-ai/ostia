import { ipcMain } from 'electron'
import { type AgentResume, parseAgentResume } from '../../shared/agents/agentResume'
import type { ResumeVerdict } from '../../shared/agents/agentsApi'
import { getByPaneId, panesOwnedBy } from '../control/idRegistry'
import type { PaneEntry } from '../panes/paneList'

export const RESUME_CLAIM_MS = 10_000

interface Claim {
  agent: string
  id: string
  at: number
}

export type ResumeClaimer = (externalId: string, resume: AgentResume) => Promise<ResumeVerdict>

export function createResumeClaimer(
  panes: () => Promise<PaneEntry[]>,
  now: () => number = Date.now,
): ResumeClaimer {
  const claims = new Map<string, Claim>()
  return async (externalId, resume) => {
    const list = await panes()
    const at = now()
    const same = (agent: string | undefined, id: string | undefined): boolean =>
      agent === resume.agent && id === resume.id
    const live = list.find(
      (p) => p.paneId !== externalId && same(p.agent, p.agentSessionId) && p.hibernated !== true,
    )
    if (live) return { ok: false, holder: live.title }
    for (const [other, claim] of claims) {
      const pane = list.find((p) => p.paneId === other)
      if (at - claim.at >= RESUME_CLAIM_MS || !pane) {
        claims.delete(other)
        continue
      }
      if (other !== externalId && same(claim.agent, claim.id)) {
        return { ok: false, holder: pane.title }
      }
    }
    claims.set(externalId, { agent: resume.agent, id: resume.id, at })
    return { ok: true }
  }
}

export function registerResumeClaimIpc(claim: ResumeClaimer): void {
  ipcMain.handle(
    'agent:claim-resume',
    async (e, paneId: unknown, raw: unknown): Promise<ResumeVerdict> => {
      const resume = parseAgentResume(raw)
      const identity = typeof paneId === 'string' ? getByPaneId(paneId) : undefined
      if (!resume || !identity || !panesOwnedBy([identity.paneId], String(e.sender.id))) {
        return { ok: false, holder: '' }
      }
      return claim(identity.externalId, resume)
    },
  )
}
