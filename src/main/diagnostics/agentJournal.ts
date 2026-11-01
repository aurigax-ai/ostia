import {
  budgetBreach,
  MAIL_LEASE_TIMEOUT,
  OVER_BUDGET,
  READBACK_CODES,
  READBACK_MISMATCH,
  verbCode,
  WAKE_NOT_READY,
} from '../../shared/agents/agentIssues'
import type { AppLog } from './appLog'
import type { IncidentTimeline } from './incidentTimeline'

type AgentCaller = 'pane' | 'script' | 'extension'

interface AgentCall {
  method: string
  caller: AgentCaller
  ms: number
  bytes: number
  code?: string
}

export interface AgentJournal {
  call: (call: AgentCall) => void
  mail: (code: string, ageMs: number, to?: string) => void
  leaseTimeout: (ageMs: number, to?: string) => void
  wakeNotReady: (ms: number, paneIds?: string[]) => void
}

export const AGENT_JOURNAL_FILE_NAME = 'agent-journal.log'
export const AGENT_JOURNAL_MAX_BYTES = 512 * 1024
export const AGENT_JOURNAL_KEEP = 2

const METHOD = /^[a-z][A-Za-z.]{0,60}$/

export function createAgentJournal(
  log: Pick<AppLog, 'info' | 'warn'>,
  incidents?: Pick<IncidentTimeline, 'mail' | 'wake'>,
): AgentJournal {
  return {
    call: ({ method, caller, ms, bytes, code: raw }) => {
      const code = raw === undefined ? undefined : verbCode(raw)
      const over = budgetBreach(method, ms, bytes)
      const outcome =
        code === undefined ? 'ok' : READBACK_CODES.has(code) ? READBACK_MISMATCH : 'error'
      const fields = {
        method: METHOD.test(method) ? method : 'other',
        caller,
        outcome,
        ...(code === undefined ? {} : { code }),
        ms: Math.round(ms),
        bytes,
        ...(over ? { over } : {}),
      }
      if (over || outcome !== 'ok')
        log.warn(over && outcome === 'ok' ? OVER_BUDGET : 'call', fields)
      else log.info('call', fields)
    },
    mail: (code, ageMs, to) => {
      log.warn('mail-failed', { code, age: Math.round(ageMs) })
      if (to) incidents?.mail(to, verbCode(code), ageMs)
    },
    leaseTimeout: (ageMs, to) => {
      log.warn('mail-lease', { code: MAIL_LEASE_TIMEOUT, age: Math.round(ageMs) })
      if (to) incidents?.mail(to, MAIL_LEASE_TIMEOUT, ageMs)
    },
    wakeNotReady: (ms, paneIds) => {
      log.warn('wake', { code: WAKE_NOT_READY, ms: Math.round(ms) })
      for (const paneId of paneIds ?? []) incidents?.wake(paneId, WAKE_NOT_READY, ms)
    },
  }
}
