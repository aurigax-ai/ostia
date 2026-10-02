import { isResumableAgent } from '../shared/agentResume'
import type {
  AttentionState,
  OriginAgentTarget,
  OriginAgents,
  OriginReferenceRequest,
  PaneAgentKind,
  ReferenceInsert,
  WindowPaneReport,
  WindowPaneSummary,
  WindowWorkspaceReport,
  WindowWorkspaceSummary,
} from '../shared/types'
import { crossesSandbox } from './windowBook'

export const REFERENCE_TEXT_MAX = 64 * 1024
export const REFERENCE_NOTE_MAX = 120
export const REFERENCE_REPLY_MS = 3000

const ID_MAX = 256
const ATTENTION_STATES: ReadonlySet<string> = new Set<AttentionState>([
  'none',
  'working',
  'waiting',
  'done',
  'error',
])

export type WindowReports = ReadonlyMap<string, readonly WindowWorkspaceReport[]>

export interface OriginRules {
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  isManagerPane: (paneId: string) => boolean
  ownerOfPane: (paneId: string) => string | undefined
}

export type OriginReach = (
  senderWindowId: string,
  sourcePaneId: string,
  targetPaneId: string,
) => boolean

export function parsePaneAgent(raw: unknown): PaneAgentKind | undefined {
  return raw === 'other' || isResumableAgent(raw) ? raw : undefined
}

export function parseAttentionState(raw: unknown): AttentionState | undefined {
  return typeof raw === 'string' && ATTENTION_STATES.has(raw) ? (raw as AttentionState) : undefined
}

function summaryOfPane(pane: WindowPaneReport): WindowPaneSummary {
  return { id: pane.id, title: pane.title }
}

export function summaryOf(report: WindowWorkspaceReport): WindowWorkspaceSummary {
  const { origin: _origin, panes, ...rest } = report
  return { ...rest, panes: panes.map(summaryOfPane) }
}

interface OriginHome {
  windowId: string
  workspace: WindowWorkspaceReport
}

function originHome(
  reports: WindowReports,
  rules: OriginRules,
  windowId: string,
  workspaceId: string,
): OriginHome | null {
  const own = reports.get(windowId)?.find((w) => w.id === workspaceId)
  const origin = own?.origin
  if (!own || !origin || origin === own.id) return null
  if (rules.isScratch(own.id) || rules.isScratch(origin)) return null
  if (crossesSandbox([own.id], origin, rules.isSandboxed)) return null
  for (const [owner, workspaces] of reports) {
    if (owner === windowId) continue
    const workspace = workspaces.find((w) => w.id === origin)
    if (workspace) return { windowId: owner, workspace }
  }
  return null
}

function agentTargets(home: OriginHome, rules: OriginRules): OriginAgentTarget[] {
  const targets: OriginAgentTarget[] = []
  for (const pane of home.workspace.panes) {
    if (!pane.agent || rules.isManagerPane(pane.id)) continue
    if (rules.ownerOfPane(pane.id) !== home.windowId) continue
    targets.push({
      paneId: pane.id,
      title: pane.title,
      agent: pane.agent,
      state: pane.state ?? 'none',
      ...(pane.cwd ? { cwd: pane.cwd } : {}),
    })
  }
  return targets
}

export function originAgents(
  reports: WindowReports,
  rules: OriginRules,
  windowId: string,
  workspaceId: unknown,
): OriginAgents | null {
  if (typeof workspaceId !== 'string') return null
  const home = originHome(reports, rules, windowId, workspaceId)
  if (!home) return null
  return {
    workspaceId: home.workspace.id,
    workspaceName: home.workspace.name,
    targets: agentTargets(home, rules),
  }
}

export function originAgentOwner(
  reports: WindowReports,
  rules: OriginRules,
  windowId: string,
  workspaceId: string,
  paneId: string,
): string | null {
  const home = originHome(reports, rules, windowId, workspaceId)
  if (!home) return null
  return agentTargets(home, rules).some((t) => t.paneId === paneId) ? home.windowId : null
}

export function workspaceOfPane(
  reports: WindowReports,
  windowId: string,
  paneId: string,
): string | null {
  const workspace = reports.get(windowId)?.find((w) => w.panes.some((p) => p.id === paneId))
  return workspace?.id ?? null
}

export function reachesTarget(
  reports: WindowReports,
  rules: OriginRules,
  senderWindowId: string,
  sourcePaneId: string,
  targetPaneId: string,
): boolean {
  if (rules.ownerOfPane(sourcePaneId) !== senderWindowId) return false
  if (rules.ownerOfPane(targetPaneId) === senderWindowId) return true
  const workspaceId = workspaceOfPane(reports, senderWindowId, sourcePaneId)
  if (!workspaceId) return false
  return originAgentOwner(reports, rules, senderWindowId, workspaceId, targetPaneId) !== null
}

export function parseReferenceRequest(raw: unknown): OriginReferenceRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { workspaceId, paneId, text, note } = raw as Record<string, unknown>
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > ID_MAX) return null
  if (typeof paneId !== 'string' || !paneId || paneId.length > ID_MAX) return null
  if (typeof text !== 'string' || !text || text.length > REFERENCE_TEXT_MAX) return null
  const summary =
    typeof note === 'string' ? note.trim().replace(/\s+/g, ' ').slice(0, REFERENCE_NOTE_MAX) : ''
  return { workspaceId, paneId, text, ...(summary ? { note: summary } : {}) }
}

interface PendingInsert {
  windowId: string
  settle: (inserted: boolean) => void
}

export class ReferenceRelay {
  private readonly pending = new Map<string, PendingInsert>()
  private seq = 0

  constructor(
    private readonly deliver: (windowId: string, insert: ReferenceInsert) => boolean,
    private readonly replyMs: number = REFERENCE_REPLY_MS,
  ) {}

  forward(windowId: string, request: OriginReferenceRequest): Promise<boolean> {
    this.seq += 1
    const requestId = `reference-${this.seq}`
    return new Promise((resolve) => {
      const settle = (inserted: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(inserted)
      }
      const timer = setTimeout(() => settle(false), this.replyMs)
      this.pending.set(requestId, { windowId, settle })
      const insert: ReferenceInsert = {
        requestId,
        paneId: request.paneId,
        text: request.text,
        ...(request.note ? { note: request.note } : {}),
      }
      if (!this.deliver(windowId, insert)) settle(false)
    })
  }

  answer(windowId: string, requestId: unknown, inserted: unknown): void {
    if (typeof requestId !== 'string') return
    const entry = this.pending.get(requestId)
    if (entry?.windowId === windowId) entry.settle(inserted === true)
  }

  windowClosed(windowId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.windowId === windowId) entry.settle(false)
    }
  }
}
