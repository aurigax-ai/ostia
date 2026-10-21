import { describe, expect, it } from 'vitest'
import {
  AGENT_VERB_BUDGETS,
  budgetBreach,
  mailExpired,
  READBACK_CODES,
  verbCode,
} from './agentIssues'

describe('verbCode', () => {
  it('takes the code before the colon of the existing answer prefix', () => {
    expect(verbCode('unknown-pane: 3f2a…')).toBe('unknown-pane')
    expect(verbCode('not-submitted: the pane shows the text')).toBe('not-submitted')
    expect(verbCode('sandboxed')).toBe('sandboxed')
  })

  it('never lets free text, digits, capitals or a secret through as a code', () => {
    for (const message of [
      'denied the thing because',
      'sk-live-1234567890',
      'Error: boom',
      '',
      'a'.repeat(60),
      'unknown identity',
    ]) {
      expect(verbCode(message)).toBe('error')
    }
  })

  it('builds the expiry reason from the last pending reason', () => {
    expect(mailExpired('hibernated')).toBe('expired:hibernated')
  })

  it('knows the read-back mismatch codes of the verbs', () => {
    for (const code of [
      'not-submitted',
      'not-queued',
      'not-started',
      'not-recorded',
      'still-open',
    ]) {
      expect(READBACK_CODES.has(code)).toBe(true)
    }
    expect(READBACK_CODES.has('unknown-pane')).toBe(false)
  })
})

describe('budgetBreach', () => {
  it('names the budget that was passed, time before size, and nothing for a verb without a budget', () => {
    const read = AGENT_VERB_BUDGETS['pane.read']
    expect(budgetBreach('pane.read', (read.ms ?? 0) + 1, 1)).toBe('ms')
    expect(budgetBreach('pane.read', 1, (read.bytes ?? 0) + 1)).toBe('bytes')
    expect(budgetBreach('pane.read', read.ms ?? 0, read.bytes ?? 0)).toBeUndefined()
    expect(budgetBreach('whoami', 99_999, 99_999_999)).toBeUndefined()
  })
})
