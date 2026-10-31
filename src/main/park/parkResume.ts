import type { ParkedItem } from '@aurigax-ai/ostia-extension-sdk'
import type { AgentResume } from '../../shared/agents/agentResume'
import type { ParkedRecord, ParkedStore } from './parkedStore'

interface ParkedFail {
  ok: false
  error: 'unknown-parked' | 'workspace-closed' | 'folder-gone' | 'running-elsewhere' | 'unavailable'
  message?: string
}

export type ParkedActResult = { ok: true } | ParkedFail

export interface ParkResumeDeps {
  store: ParkedStore
  workspaceOpen: (workspaceId: string) => Promise<boolean>
  isDirectory: (path: string) => Promise<boolean>
  holderOf: (resume: AgentResume) => Promise<string | null>
  openTab: (workspaceId: string, record: ParkedRecord) => Promise<boolean>
}

export function parkedItemOf(record: ParkedRecord): ParkedItem | null {
  const { id, workspaceId, resume, title, summary, parkedAt } = record
  if (resume.agent === 'agy') return null
  return {
    id,
    workspaceId,
    agent: resume.agent,
    sessionId: resume.id,
    title,
    ...(summary ? { summary } : {}),
    ...(resume.cwd ? { folder: resume.cwd } : {}),
    parkedAt,
  }
}

export async function resumeParked(deps: ParkResumeDeps, id: string): Promise<ParkedActResult> {
  const record = deps.store.get(id)
  if (!record) return { ok: false, error: 'unknown-parked' }
  if (!(await deps.workspaceOpen(record.workspaceId))) {
    return { ok: false, error: 'workspace-closed' }
  }
  const folder = record.resume.cwd
  if (!folder || !(await deps.isDirectory(folder))) {
    return { ok: false, error: 'folder-gone', message: folder ?? '' }
  }
  const holder = await deps.holderOf(record.resume)
  if (holder !== null) return { ok: false, error: 'running-elsewhere', message: holder }
  return (await deps.openTab(record.workspaceId, record))
    ? { ok: true }
    : { ok: false, error: 'unavailable' }
}

export function forgetParked(store: ParkedStore, id: string): ParkedActResult {
  return store.remove(id) ? { ok: true } : { ok: false, error: 'unknown-parked' }
}
