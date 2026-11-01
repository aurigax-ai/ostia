import { describe, expect, it } from 'vitest'
import { INCIDENT_EVENTS_MAX, INCIDENT_WINDOW_MS } from '../../shared/agents/incident'
import { bindIncident, createIncidentTimeline, runInIncident } from './incidentTimeline'

const snapshot = { agent: 'claude', state: 'waiting', drafting: true, mail: 2 }

function make() {
  let now = 1000
  const timeline = createIncidentTimeline({ now: () => now, snapshot: async () => snapshot })
  return {
    timeline,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('incident timeline', () => {
  it('records a call with before and after snapshots', async () => {
    const { timeline, advance } = make()
    const call = timeline.begin('pane-1', 'pane.input', 'pane-2')
    advance(120)
    call.end()
    await Promise.resolve()
    await Promise.resolve()
    const take = timeline.take('pane-1')
    expect(take?.events.map((e) => (e.k === 'call' ? e.phase : e.k))).toEqual(['start', 'end'])
    const end = take?.events[1]
    expect(end?.k === 'call' && end.ms).toBe(120)
    expect(end?.k === 'call' && end.after).toEqual(snapshot)
    expect(take?.callers).toEqual(['pane-2'])
  })

  it('names a call that never returned', () => {
    const { timeline, advance } = make()
    timeline.begin('pane-1', 'pane.input')
    advance(20_000)
    expect(timeline.list()).toEqual([
      expect.objectContaining({ paneId: 'pane-1', trigger: 'call-open' }),
    ])
    const names = timeline.take('pane-1')?.events.map((e) => (e.k === 'call' ? e.name : undefined))
    expect(names).toContain('never-returned')
  })

  it('lists only panes with trouble', () => {
    const { timeline, advance } = make()
    timeline.begin('pane-1', 'pane.list').end()
    timeline.begin('pane-2', 'pane.input').end('not-submitted')
    advance(10)
    expect(timeline.list().map((i) => [i.paneId, i.trigger])).toEqual([['pane-2', 'not-submitted']])
  })

  it('keeps at most the ring size and window', () => {
    const { timeline, advance } = make()
    for (let i = 0; i < INCIDENT_EVENTS_MAX + 20; i++) timeline.state('pane-1', 'working')
    expect(timeline.take('pane-1')?.events).toHaveLength(INCIDENT_EVENTS_MAX)
    advance(INCIDENT_WINDOW_MS + 1)
    timeline.state('pane-1', 'done')
    expect(timeline.take('pane-1')?.events).toHaveLength(1)
  })

  it('writes an odd method or code as a fixed word', () => {
    const { timeline } = make()
    timeline.begin('pane-1', '/home/me/secret').end('Has Space')
    const events = timeline.take('pane-1')?.events ?? []
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(events[1]?.k === 'call' && events[1].code).toBe('error')
  })

  it('forgets a closed pane and clears all', () => {
    const { timeline } = make()
    timeline.state('pane-1', 'working')
    timeline.forget('pane-1')
    expect(timeline.take('pane-1')).toBeUndefined()
    timeline.state('pane-2', 'working')
    timeline.clear()
    expect(timeline.take('pane-2')).toBeUndefined()
  })

  it('attaches a call to its pane when the pane is resolved later, and drops one that never is', () => {
    const { timeline } = make()
    const named = timeline.begin(undefined, 'pane.input')
    runInIncident(named, () => bindIncident('pane-1'))
    named.end('not-submitted')
    timeline.begin(undefined, 'pane.list').end()
    expect(timeline.list().map((i) => [i.paneId, i.trigger])).toEqual([['pane-1', 'not-submitted']])
    expect(timeline.take('pane-1')?.events).toHaveLength(2)
  })
})
