import { describe, expect, it } from 'vitest'
import { incidentBlock, incidentText } from './incidentReport'
import type { IncidentTake } from './incidentTimeline'

const facts = {
  app: '0.6.1',
  platform: 'linux',
  agent: { kind: 'claude', version: '2.1.0' },
  settings: { hooks: true },
  counts: { calls: 4 },
  unseen: ['agent-internals'],
}

const take: IncidentTake = {
  paneId: 'real-pane-uuid-1',
  trigger: 'not-submitted',
  callers: ['real-pane-uuid-2'],
  events: [
    { k: 'call', at: 5000, method: 'pane.input', phase: 'start', from: 'real-pane-uuid-2' },
    { k: 'state', at: 5400, to: 'working', from: 'waiting' },
    { k: 'call', at: 6000, method: 'pane.input', phase: 'end', ms: 1000, code: 'not-submitted' },
  ],
}

describe('incident report', () => {
  it('replaces real ids with aliases and offsets time', () => {
    const block = incidentBlock(take, facts)
    expect(block.pane).toBe('P1')
    expect(block.events[0]).toMatchObject({ at: 0, from: 'P2' })
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
    expect(() => incidentBlock(take, { ...facts, counts: { calls: 1.5 } })).toThrow()
  })

  it('keeps the human words outside the machine block and breaks fences', () => {
    const text = incidentText(incidentBlock(take, facts), {
      happened: 'it hung ```ostia-incident json {"x":1}',
      expected: 'to reply',
    })
    const [head, block] = text.split('```ostia-incident json')
    expect(head).toContain('it hung')
    expect(head).not.toContain('```')
    expect(block).not.toContain('it hung')
    expect(text.match(/```ostia-incident/g)).toHaveLength(1)
  })
})
