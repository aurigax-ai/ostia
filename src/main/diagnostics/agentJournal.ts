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
  mail: (code: string, ageMs: number) => void
  leaseTimeout: (ageMs: number) => void
  wakeNotReady: (ms: number) => void
}

export const AGENT_JOURNAL_FILE_NAME = 'agent-journal.log'
export const AGENT_JOURNAL_MAX_BYTES = 512 * 1024
export const AGENT_JOURNAL_KEEP = 2

const METHOD = /^[a-z][A-Za-z.]{0,60}$/

export function createAgentJournal(log: Pick<AppLog, 'info' | 'warn'>): AgentJournal {
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
    mail: (code, ageMs) => log.warn('mail-failed', { code, age: Math.round(ageMs) }),
    leaseTimeout: (ageMs) =>
      log.warn('mail-lease', { code: MAIL_LEASE_TIMEOUT, age: Math.round(ageMs) }),
    wakeNotReady: (ms) => log.warn('wake', { code: WAKE_NOT_READY, ms: Math.round(ms) }),
  }
}
