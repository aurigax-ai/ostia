import {
  actThenConfirm,
  anyOf,
  confirmed,
  mismatch,
  pollEvery,
  type Settled,
  type Subscribe,
} from '../../shared/common/actThenConfirm'
import type { ProcessEntry, ProcessRegistry, StartOutcome } from './processRegistry'

export interface StartTiming {
  settleMs: number
  processMs: number
  agentMs: number
  turnMs: number
  pollMs: number
}

export const START_TIMING: StartTiming = {
  settleMs: 1000,
  processMs: 15_000,
  agentMs: 60_000,
  turnMs: 20_000,
  pollMs: 200,
}

export interface StartReport {
  status: StartOutcome
  turnStarted?: boolean
  session?: string
  exitCode?: number
  output?: string[]
  reason?: string
}

export interface StartWatch {
  registry: ProcessRegistry
  entry: ProcessEntry
  agentHook: boolean
  agentStarted: (paneId: string) => boolean
  changes: Subscribe
  timing: StartTiming
}

const OUTPUT_LINES = 20

function lastLines(registry: ProcessRegistry, entry: ProcessEntry): string[] {
  const text = registry.output(entry, 0)?.data ?? ''
  const lines = text.replace(/\s+$/, '').split('\n')
  return text.trim() ? lines.slice(-OUTPUT_LINES) : []
}

function exitedReport(watch: StartWatch, agent: boolean): Settled<StartReport> {
  const { entry, registry } = watch
  const output = lastLines(registry, entry)
  const code = entry.exitCode
  if (!agent && code === 0) return confirmed({ status: 'exited', exitCode: 0, output })
  const reason = agent
    ? `the agent's command ended${code === undefined ? '' : ` with exit code ${code}`} before the agent started`
    : `the command ended with exit code ${code ?? 'unknown'}`
  return mismatch(reason, {
    status: 'failed',
    ...(code === undefined ? {} : { exitCode: code }),
    output,
    reason,
  })
}

export async function confirmStart(watch: StartWatch): Promise<StartReport> {
  const { entry, timing } = watch
  const agent = watch.agentHook
  let runningSince: number | undefined
  const observe = (): Settled<StartReport> | undefined => {
    if (entry.status === 'closed') {
      return mismatch('its tab was closed', { status: 'failed', reason: 'its tab was closed' })
    }
    if (entry.status === 'exited') return exitedReport(watch, agent)
    if (agent && watch.agentStarted(entry.paneId)) return confirmed({ status: 'started' })
    if (entry.status !== 'running') return undefined
    runningSince ??= Date.now()
    if (agent || Date.now() - runningSince < timing.settleMs) return undefined
    return confirmed({ status: 'started' })
  }
  const settled = await actThenConfirm<StartReport>({
    act: () => undefined,
    observe,
    signal: anyOf(watch.changes, pollEvery(timing.pollMs)),
    timeoutMs: agent ? timing.agentMs : timing.processMs,
    onTimeout: () => {
      const reason =
        entry.status === 'starting'
          ? 'the command did not start: its tab never reached a ready prompt'
          : 'the agent did not report its start'
      return mismatch(reason, { status: 'timed-out', reason })
    },
  })
  return settled.value ?? { status: 'failed', reason: settled.ok ? undefined : settled.reason }
}

export interface TurnWatch {
  entry: ProcessEntry
  turnState: (paneId: string) => Promise<string | undefined>
  session: (paneId: string) => Promise<string | undefined>
  changes: Subscribe
  timing: StartTiming
}

const TURN_STATES: ReadonlySet<string | undefined> = new Set([
  'working',
  'waiting',
  'done',
  'error',
])

export async function confirmTurn(
  watch: TurnWatch,
): Promise<Pick<StartReport, 'turnStarted' | 'session'>> {
  const { entry, timing } = watch
  const settled = await actThenConfirm<boolean>({
    act: () => undefined,
    observe: async () => {
      if (entry.status === 'closed' || entry.status === 'exited') return confirmed(false)
      return TURN_STATES.has(await watch.turnState(entry.paneId)) ? confirmed(true) : undefined
    },
    signal: anyOf(watch.changes, pollEvery(timing.pollMs)),
    timeoutMs: timing.turnMs,
    onTimeout: () => confirmed(false),
  })
  const session = await watch.session(entry.paneId)
  return { turnStarted: settled.value === true, ...(session ? { session } : {}) }
}

export function startMessage(name: string, paneId: string, report: StartReport): string {
  const head = `ostia: ${name} (${paneId}) ${report.status}`
  const code = report.exitCode === undefined ? '' : `, exit code ${report.exitCode}`
  const why = report.reason ? `: ${report.reason}` : ''
  const tail = report.output && report.output.length > 0 ? `\n${report.output.join('\n')}` : ''
  return `${head}${code}${why}${tail}`
}
