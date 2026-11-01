import { describe, expect, it } from 'vitest'
import { incidentBlock, incidentText } from './incidentReport'
import type { IncidentTake } from './incidentTimeline'

const facts = {
  app: '0.6.1',
  platform: 'linux',
  agent: { kind: 'claude', version: '2.1.0' },
  settings: { hooks: true },
  counts: { 'pane.input.ok': 14, 'pane.input.not-submitted': 1, 'pane.wake.ok': 3 },
  sinceMin: 42,
  unseen: ['agent-internals', 'terminal-text'],
}

const waking = {
  agent: 'claude',
  state: 'waking',
  drafting: false,
  mail: 0,
  alive: true,
}

const take: IncidentTake = {
  paneId: 'real-pane-uuid-1',
  agent: 'claude',
  trigger: 'not-submitted',
  callers: ['real-pane-uuid-2'],
  events: [
    { k: 'state', at: 1000, to: 'waking', from: 'hibernated' },
    { k: 'hook', at: 2000, ok: true, code: 'prompt-submit' },
    {
      k: 'call',
      at: 5000,
      method: 'pane.input',
      phase: 'start',
      from: 'real-pane-uuid-2',
      before: waking,
    },
    { k: 'state', at: 5400, to: 'working', from: 'waking' },
    {
      k: 'call',
      at: 9800,
      method: 'pane.input',
      phase: 'end',
      from: 'real-pane-uuid-2',
      ms: 4800,
      code: 'not-submitted',
      after: { ...waking, drafting: true },
    },
  ],
}

const words = { happened: 'it hung', expected: 'to reply' }

describe('incident report block', () => {
  it('puts callers first, the target last and replaces real ids with aliases', () => {
    const block = incidentBlock(take, facts)
    expect(block.pane).toBe('P2')
    expect(block.events[2]).toMatchObject({ at: 4000, from: 'P1' })
    expect(JSON.stringify(block)).not.toContain('real-pane')
  })

  it('refuses any field outside the schema', () => {
    const bad = {
      ...take,
      events: [{ k: 'call', at: 0, method: 'pane.input', phase: 'start', text: 'hello' }],
    } as unknown as IncidentTake
    expect(() => incidentBlock(bad, facts)).toThrow()
  })

  it.each([
    ['path', { method: '/home/me/x' }],
    ['id', { method: 'pane.input', code: 'f24ee459-4123-4d17-9438-152c5f346c23' }],
    ['space', { method: 'pane.input', code: 'has space' }],
  ])('refuses a %s in a coded field', (_name, field) => {
    const bad = {
      ...take,
      events: [{ k: 'call', at: 0, phase: 'end', ...field }],
    } as unknown as IncidentTake
    expect(() => incidentBlock(bad, facts)).toThrow()
  })

  it('refuses free text in settings, agent and counts', () => {
    expect(() => incidentBlock(take, { ...facts, settings: { 'a b': true } })).toThrow()
    expect(() => incidentBlock(take, { ...facts, agent: { kind: '/usr/bin/claude' } })).toThrow()
    expect(() => incidentBlock(take, { ...facts, counts: { 'pane.input.ok': 1.5 } })).toThrow()
    expect(() => incidentBlock(take, { ...facts, counts: { '/home/me.ok': 1 } })).toThrow()
  })
})

describe('incident report text', () => {
  const text = incidentText(incidentBlock(take, facts), words)

  it('starts with a bold headline that names the failure', () => {
    expect(text.split('\n')[0]).toBe('**Enter not submitted**')
  })

  it('writes the timeline as aligned columns with states in words', () => {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith('Timeline'))
    expect(lines.slice(start + 1, start + 6)).toEqual([
      '-8.8  P2     state       hibernated → starting',
      '-7.8  P2     hook        prompt submit',
      '-4.8  P1→P2  pane.input  not submitted 4.8 s',
      '                         before: starting · no prompt · draft empty',
      '                         after:  starting · no prompt · draft present',
    ])
  })

  it('names the target at the failure, what Ostia could not see and the background', () => {
    expect(text).toContain(
      'P2 at the failure: hooks installed · last hook prompt submit 7.8 s before · pty alive · foreground claude',
    )
    expect(text).toContain(
      "Ostia could not see: the agent's own screen and reasoning, terminal text",
    )
    expect(text).toContain(
      'Background (42 min): pane.input 14 ok / 1 not submitted · pane.wake 3 ok',
    )
  })

  it('keeps the human words out of the machine block and breaks fences', () => {
    const fenced = incidentText(incidentBlock(take, facts), {
      happened: 'it hung ```ostia-incident json {"x":1}',
      expected: 'to reply',
    })
    const [head, block] = fenced.split('```ostia-incident json')
    expect(head).toContain('it hung')
    expect(head).not.toContain('```')
    expect(block).not.toContain('it hung')
    expect(fenced.match(/```ostia-incident/g)).toHaveLength(1)
  })

  it('names the call that never returned', () => {
    const open = incidentText(
      incidentBlock(
        {
          ...take,
          trigger: 'call-open',
          callers: [],
          events: [
            { k: 'call', at: 0, method: 'pane.wait', phase: 'start' },
            {
              k: 'call',
              at: 30_000,
              method: 'pane.wait',
              phase: 'phase',
              name: 'never-returned',
              ms: 30_000,
            },
          ],
        },
        facts,
      ),
      words,
    )
    expect(open.split('\n')[0]).toBe('**A call never returned**')
    expect(open).toContain('pane.wait  never returned 30.0 s')
  })
})
