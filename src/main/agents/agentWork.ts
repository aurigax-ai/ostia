import { execFile } from 'node:child_process'
import {
  type AgentBusyReason,
  type AgentWorkReport,
  normalizeWorkReport,
} from '../../shared/agentWork'
import { registerControlMethod } from '../control/controlServer'

interface ReportedWork {
  subagents: Set<string>
  tasks: number
  scheduled: number
}

export class ReportedAgentWork {
  private readonly panes = new Map<string, ReportedWork>()

  report(paneId: string, report: AgentWorkReport): void {
    const work = this.panes.get(paneId) ?? { subagents: new Set<string>(), tasks: 0, scheduled: 0 }
    this.panes.set(paneId, work)
    if (report.turnEnded && report.tasks !== undefined) work.subagents.clear()
    if (report.subagentStarted !== undefined) work.subagents.add(report.subagentStarted)
    if (report.subagentStopped !== undefined) work.subagents.delete(report.subagentStopped)
    if (report.tasks !== undefined) work.tasks = report.tasks
    if (report.scheduled !== undefined) work.scheduled = report.scheduled
  }

  clear(paneId: string): void {
    this.panes.delete(paneId)
  }

  reason(paneId: string): AgentBusyReason | null {
    const work = this.panes.get(paneId)
    if (!work) return null
    if (work.subagents.size > 0) return 'subagent'
    if (work.tasks > 0) return 'background-task'
    if (work.scheduled > 0) return 'scheduled-task'
    return null
  }
}

export interface ProcessRow {
  pid: number
  ppid: number
  state: string
  tty: string
}

export const PROCESS_TABLE_ARGS = ['-axo', 'pid=,ppid=,stat=,tty=']

const PROCESS_TABLE_TIMEOUT_MS = 3000
const PROCESS_TABLE_MAX_BYTES = 8 * 1024 * 1024
const FOREGROUND = '+'
const ZOMBIE = 'Z'

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const [pid, ppid, state, tty] = line.trim().split(/\s+/)
    if (!state || !tty) continue
    const row = { pid: Number(pid), ppid: Number(ppid), state, tty }
    if (Number.isInteger(row.pid) && Number.isInteger(row.ppid) && row.pid > 0) rows.push(row)
  }
  return rows
}

export function readProcessTable(): Promise<ProcessRow[] | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      PROCESS_TABLE_ARGS,
      { timeout: PROCESS_TABLE_TIMEOUT_MS, maxBuffer: PROCESS_TABLE_MAX_BYTES },
      (error, stdout) => resolve(error ? null : parseProcessTable(stdout)),
    )
  })
}

function descendants(of: ProcessRow, children: Map<number, ProcessRow[]>): ProcessRow[] {
  const out: ProcessRow[] = []
  const queue = [...(children.get(of.pid) ?? [])]
  for (let next = queue.shift(); next; next = queue.shift()) {
    out.push(next)
    queue.push(...(children.get(next.pid) ?? []))
  }
  return out
}

export function processWork(
  rows: readonly ProcessRow[] | null,
  ptyPid: number,
): AgentBusyReason | null {
  if (!rows) return 'unknown'
  const live = rows.filter((row) => !row.state.startsWith(ZOMBIE))
  const root = live.find((row) => row.pid === ptyPid)
  if (!root) return 'unknown'
  const children = new Map<number, ProcessRow[]>()
  for (const row of live) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const foreground = [root, ...descendants(root, children)].filter((row) =>
    row.state.includes(FOREGROUND),
  )
  if (foreground.length === 0) return 'unknown'
  const detached = foreground.some((agent) =>
    descendants(agent, children).some((child) => child.tty !== agent.tty),
  )
  return detached ? 'child-process' : null
}

export function backgroundWork(
  reported: AgentBusyReason | null,
  rows: readonly ProcessRow[] | null,
  ptyPid: number,
): AgentBusyReason | null {
  return reported ?? processWork(rows, ptyPid)
}

export function registerAgentWorkMethods(work: ReportedAgentWork): void {
  registerControlMethod('pane.reportWork', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      work.report(ctx.identity.paneId, normalizeWorkReport(params))
      return { ok: true }
    },
  })
}
