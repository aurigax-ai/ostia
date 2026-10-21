import { type AgentResume, parseAgentResume } from '../../shared/agents/agentResume'
import type { AgentBusyReason } from '../../shared/agents/agentWork'
import { PARK_SUMMARY_MAX, type ParkOutcome, parkRefusal, singleLine } from '../../shared/park/park'
import type { PaneIdentity } from '../control/idRegistry'
import type { ParkedStore } from './parkedStore'

export interface ParkActDeps {
  store: ParkedStore
  identityOf: (paneId: string) => PaneIdentity | undefined
  workspaceKind: (workspaceId: string) => Promise<string | null>
  isScratch: (workspaceId: string) => boolean
  isSandboxed: (workspaceId: string) => boolean
  isRemote: (paneId: string) => boolean
  agentRunning: (paneId: string) => boolean
  resumeOf: (identity: PaneIdentity) => Promise<AgentResume | null>
  paneCwd: (paneId: string) => string | undefined
  attentionState: (identity: PaneIdentity) => Promise<string | undefined>
  busy: (paneId: string) => Promise<AgentBusyReason | null>
  closing: (paneId: string) => string | undefined
  title: (identity: PaneIdentity) => Promise<string | undefined>
  lockedOf: (identity: PaneIdentity) => Promise<boolean>
  closePane: (identity: PaneIdentity) => Promise<'closed' | 'locked' | 'failed'>
  redact: (text: string) => Promise<string>
}

const TITLE_MAX = 200

async function redacted(deps: ParkActDeps, text: string | undefined, max: number) {
  const line = text === undefined ? '' : singleLine(text, max)
  if (line === '') return undefined
  try {
    const safe = singleLine(await deps.redact(line), max)
    return safe === '' ? undefined : safe
  } catch {
    return undefined
  }
}

export async function parkPane(
  deps: ParkActDeps,
  workspaceId: string,
  paneId: string,
  titlePinned: boolean,
): Promise<ParkOutcome> {
  const identity = deps.identityOf(paneId)
  if (!identity || identity.workspaceId !== workspaceId) {
    return { ok: false, reason: 'unavailable' }
  }
  const kind = await deps.workspaceKind(workspaceId)
  if (kind === null) return { ok: false, reason: 'workspace-closed' }
  const token = await deps.resumeOf(identity)
  const refusal = parkRefusal({
    manager: identity.manager === true,
    workspaceKind: deps.isScratch(workspaceId) ? 'scratch' : kind,
    sandboxed: deps.isSandboxed(workspaceId),
    remote: deps.isRemote(identity.paneId),
    locked: await deps.lockedOf(identity),
    agentRunning: deps.agentRunning(identity.paneId),
    hasResume: token !== null,
    working: (await deps.attentionState(identity)) === 'working',
  })
  if (refusal) return { ok: false, reason: refusal }
  const busy = await deps.busy(identity.paneId)
  if (busy) return { ok: false, reason: busy }
  const resume = token
    ? parseAgentResume({ ...token, cwd: token.cwd ?? deps.paneCwd(identity.paneId) })
    : null
  if (!resume?.cwd) return { ok: false, reason: 'no-session' }
  const title = (await redacted(deps, await deps.title(identity), TITLE_MAX)) ?? resume.agent
  const result = deps.store.park({
    workspaceId,
    resume,
    title,
    ...(titlePinned ? { titlePinned: true as const } : {}),
    summary: await redacted(deps, deps.closing(identity.paneId), PARK_SUMMARY_MAX),
  })
  if (!result.ok) {
    return { ok: false, reason: result.reason === 'too-many' ? 'too-many' : 'unavailable' }
  }
  const closed = await deps.closePane(identity)
  if (closed !== 'closed') {
    deps.store.remove(result.record.id)
    return { ok: false, reason: closed === 'locked' ? 'locked' : 'unavailable' }
  }
  return { ok: true, id: result.record.id, title: result.record.title }
}
