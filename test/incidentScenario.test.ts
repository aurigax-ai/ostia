import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { incidentBlock, incidentText } from '../src/main/diagnostics/incidentReport'
import { blockOf, scenarioOf } from './incidentScenario'

const recorded = readFileSync(join(__dirname, './fixtures/incidents/not-submitted.md'), 'utf8')

describe('incident scenario', () => {
  it('turns the recorded not-submitted report into a swallowed-Enter scenario with a draft', () => {
    const result = scenarioOf(recorded)
    expect(result).toMatchObject({
      ok: true,
      scenario: {
        method: 'pane.input',
        trigger: 'not-submitted',
        swallowEnter: true,
        draft: true,
        callMs: 4800,
      },
    })
  })

  it('reads back a report the builder wrote', () => {
    const block = incidentBlock(
      {
        paneId: 'x',
        trigger: 'call-open',
        callers: [],
        events: [{ k: 'call', at: 0, method: 'pane.wait', phase: 'start' }],
      },
      {
        app: '1.0.0',
        platform: 'linux',
        agent: { kind: 'claude' },
        settings: {},
        counts: {},
        unseen: [],
      },
    )
    const text = incidentText(block, { happened: 'stuck', expected: 'done' })
    expect(blockOf(text)).toEqual(block)
    expect(scenarioOf(text)).toMatchObject({ ok: true, scenario: { method: 'pane.wait' } })
  })

  it('says why a report has no replay model', () => {
    expect(
      scenarioOf(recorded.replace('"not-submitted",\n  "events"', '"wake-not-ready",\n  "events"')),
    ).toEqual({
      ok: false,
      reason: 'no replay model for trigger wake-not-ready',
    })
    expect(scenarioOf('nothing here')).toEqual({
      ok: false,
      reason: 'no valid ostia-incident block in the file',
    })
  })
})
