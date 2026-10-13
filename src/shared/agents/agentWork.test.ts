import { describe, expect, it } from 'vitest'
import { claudeWorkReport, normalizeWorkReport } from './agentWork'

const report = (event: Parameters<typeof claudeWorkReport>[0], payload: object) =>
  claudeWorkReport(event, JSON.stringify(payload))

describe('claudeWorkReport', () => {
  it('names the subagent a SubagentStart hook started', () => {
    expect(report('SubagentStart', { agent_id: 'agent-1', agent_type: 'Explore' })).toEqual({
      subagentStarted: 'agent-1',
    })
  })

  it('counts the background tasks and scheduled wake-ups a Stop hook lists', () => {
    expect(
      report('Stop', {
        background_tasks: [
          { id: 't1', type: 'shell', status: 'running', command: 'tail -f log' },
          { id: 't2', type: 'subagent', status: 'running' },
          { id: 't3', type: 'shell', status: 'completed' },
        ],
        session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true }],
      }),
    ).toEqual({ turnEnded: true, tasks: 2, scheduled: 1 })
  })

  it('reports an idle session when a Stop hook lists nothing in flight', () => {
    expect(report('Stop', { background_tasks: [], session_crons: [] })).toEqual({
      turnEnded: true,
      tasks: 0,
      scheduled: 0,
    })
  })

  it('leaves the counts out when the hook has no task registry to read', () => {
    expect(report('Stop', { last_assistant_message: 'done' })).toEqual({ turnEnded: true })
    expect(claudeWorkReport('Stop', 'not json')).toEqual({ turnEnded: true })
  })

  it('does not count the subagent that is stopping among the tasks still running', () => {
    expect(
      report('SubagentStop', {
        agent_id: 'agent-1',
        background_tasks: [
          { id: 'agent-1', type: 'subagent', status: 'running' },
          { id: 't9', type: 'shell', status: 'running' },
        ],
        session_crons: [],
      }),
    ).toEqual({ subagentStopped: 'agent-1', tasks: 1, scheduled: 0 })
  })
})

describe('normalizeWorkReport', () => {
  it('keeps only well-formed fields of what a pane sent', () => {
    expect(
      normalizeWorkReport({
        subagentStarted: 'a',
        subagentStopped: 7,
        turnEnded: 'yes',
        tasks: -1,
        scheduled: 2,
        extra: true,
      }),
    ).toEqual({ subagentStarted: 'a', scheduled: 2 })
    expect(normalizeWorkReport(null)).toEqual({})
  })
})
