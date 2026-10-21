import { describe, expect, it } from 'vitest'
import { BRIEF_MAX_CHARS, CLAIMS_CHECKED, intakeText, startPrompt } from './procedure'
import type { Ticket } from './tickets'

const TICKET: Ticket = {
  id: 'h7k2',
  topic: 'checkout retry loop',
  agent: 'claude',
  sessionId: 'aaaa1111-0000',
  cwd: '/w',
  workDir: '/w',
  workspaceId: 'w1',
  created: 0,
  claimedBy: 'p2',
}

describe('handoff procedure', () => {
  const text = intakeText(TICKET, '/w')

  it('names the ticket, the topic, the caller session and the brief file', () => {
    expect(text).toContain('handoff h7k2')
    expect(text).toContain('topic: checkout retry loop')
    expect(text).toContain('claude session aaaa1111-0000')
    expect(text).toContain('$OSTIA_ARTIFACTS/handoff-<slug>.md')
  })

  it('runs the steps in order with the tags and the caps', () => {
    const steps = [...text.matchAll(/^(\d)\. (\w+)/gm)].map((m) => `${m[1]}.${m[2]}`)
    expect(steps).toEqual(['1.Pin', '2.Find', '3.Read', '4.Gather', '5.Ground', '6.Brief', '7.Ask'])
    for (const tag of ['[verified]', '[wrong]', '[unverified]', '[user said]', '[agent said]']) {
      expect(text).toContain(tag)
    }
    expect(text).toContain(`${BRIEF_MAX_CHARS} characters`)
    expect(text).toContain(`${CLAIMS_CHECKED} claims`)
  })

  it('stays short and asks for no report back', () => {
    expect(text.split('\n').length).toBeLessThanOrEqual(150)
    expect(text).toContain('Do not message, ask or report to the caller')
  })

  it('never names a permission bypass or another tool', () => {
    expect(text).not.toMatch(
      /dangerously|bypassPermissions|dontAsk|danger-full-access|--no-verify|skip-permissions/i,
    )
    expect(text).not.toMatch(/mstack|mskills|trellis|keeper/i)
  })

  it('types a prompt that carries only the ticket', () => {
    expect(startPrompt('h7k2')).toBe('Run `ostia handoff intake h7k2` and follow what it prints.')
  })
})
