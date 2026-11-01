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
        replay: 'send-enter',
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
        agent: 'claude',
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
        sinceMin: 0,
        unseen: [],
      },
    )
    const text = incidentText(block, { happened: 'stuck', expected: 'done' })
    expect(blockOf(text)).toEqual(block)
    expect(scenarioOf(text)).toMatchObject({ ok: true, scenario: { replay: 'wait' } })
  })

  it('says why a report has no replay model', () => {
    expect(
      scenarioOf(recorded.replace('"not-submitted",\n  "events"', '"lease-timeout",\n  "events"')),
    ).toEqual({
      ok: false,
      reason: 'no replay model for trigger lease-timeout',
    })
    expect(scenarioOf('nothing here')).toEqual({
      ok: false,
      reason: 'no valid ostia-incident block in the file',
    })
  })

  it.each([
    ['wake-not-ready', 'wake', ['wake-not-ready', 'not-started']],
    ['undelivered-hooks-off', 'mail', ['undelivered-hooks-off']],
    ['undelivered-idle-no-wake', 'mail', ['undelivered-idle-no-wake']],
    ['folder-not-trusted', 'run-outside', ['folder-not-trusted']],
  ])('models %s as a %s replay', (trigger, replay, accept) => {
    const block = incidentBlock(
      {
        paneId: 'x',
        agent: 'claude',
        trigger,
        callers: [],
        events: [{ k: 'mail', at: 0, code: trigger }],
      },
      {
        app: '1.0.0',
        platform: 'linux',
        agent: { kind: 'claude' },
        settings: {},
        counts: {},
        sinceMin: 0,
        unseen: [],
      },
    )
    expect(scenarioOf(incidentText(block, { happened: '', expected: '' }))).toMatchObject({
      ok: true,
      scenario: { replay, accept, hooksOff: trigger === 'undelivered-hooks-off' },
    })
  })
})
