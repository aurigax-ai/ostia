import { describe, expect, it } from 'vitest'
import {
  type ProcessRow,
  ReportedAgentWork,
  backgroundWork,
  parseProcessTable,
  processWork,
} from './agentWork'

const SHELL = 100
const AGENT = 200

const row = (pid: number, ppid: number, state: string, tty: string): ProcessRow => ({
  pid,
  ppid,
  state,
  tty,
})

const idleAgent: ProcessRow[] = [
  row(1, 0, 'Ss', '?'),
  row(SHELL, 1, 'Ss', 'pts/4'),
  row(AGENT, SHELL, 'Sl+', 'pts/4'),
  row(201, AGENT, 'Sl+', 'pts/4'),
]

const backgroundShell: ProcessRow[] = [
  ...idleAgent,
  row(300, AGENT, 'Ss', '?'),
  row(301, 300, 'S', '?'),
]

describe('parseProcessTable', () => {
  it('reads the pid, parent, state and terminal of each ps line', () => {
    expect(
      parseProcessTable('  100     1 Ss   pts/4\n  200   100 S<l+ pts/4\n  300   200 Ss   ??\n'),
    ).toEqual([
      row(100, 1, 'Ss', 'pts/4'),
      row(200, 100, 'S<l+', 'pts/4'),
      row(300, 200, 'Ss', '??'),
    ])
  })

  it('skips lines that are not a process', () => {
    expect(parseProcessTable('\ngarbage\n  x y Ss pts/1\n')).toEqual([])
  })
})

describe('processWork', () => {
  it('finds nothing under an idle agent whose helpers share its terminal', () => {
    expect(processWork(idleAgent, SHELL)).toBeNull()
  })

  it('finds a background shell the agent started away from its terminal', () => {
    expect(processWork(backgroundShell, SHELL)).toBe('child-process')
  })

  it('finds a command an agent helper runs on a terminal of its own', () => {
    expect(processWork([...idleAgent, row(400, 201, 'Ss+', 'pts/9')], SHELL)).toBe('child-process')
  })

  it('ignores a child that already ended and a job the shell runs beside the agent', () => {
    expect(
      processWork([...idleAgent, row(300, AGENT, 'Z', '?'), row(500, SHELL, 'S', '?')], SHELL),
    ).toBeNull()
  })

  it('cannot tell when the table is missing, the shell is gone or nothing holds the terminal', () => {
    expect(processWork(null, SHELL)).toBe('unknown')
    expect(processWork(idleAgent, 999)).toBe('unknown')
    expect(
      processWork([row(SHELL, 1, 'Ss', 'pts/4'), row(AGENT, SHELL, 'S', 'pts/4')], SHELL),
    ).toBe('unknown')
  })
})

describe('ReportedAgentWork', () => {
  it('holds a pane busy from a subagent start until that subagent stops', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { subagentStarted: 'a' })
    work.report('p1', { subagentStarted: 'b' })
    work.report('p1', { subagentStopped: 'a' })
    expect(work.reason('p1')).toBe('subagent')
    work.report('p1', { subagentStopped: 'b' })
    expect(work.reason('p1')).toBeNull()
    expect(work.reason('other')).toBeNull()
  })

  it('follows the background tasks and scheduled wake-ups of the latest report', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { turnEnded: true, tasks: 2, scheduled: 1 })
    expect(work.reason('p1')).toBe('background-task')
    work.report('p1', { turnEnded: true, tasks: 0, scheduled: 1 })
    expect(work.reason('p1')).toBe('scheduled-task')
    work.report('p1', { turnEnded: true, tasks: 0, scheduled: 0 })
    expect(work.reason('p1')).toBeNull()
  })

  it('drops a subagent whose stop never arrived once a finished turn lists the tasks in flight', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { subagentStarted: 'lost' })
    work.report('p1', { turnEnded: true })
    expect(work.reason('p1')).toBe('subagent')
    work.report('p1', { turnEnded: true, tasks: 0, scheduled: 0 })
    expect(work.reason('p1')).toBeNull()
  })

  it('forgets a pane whose shell ended', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { subagentStarted: 'a' })
    work.clear('p1')
    expect(work.reason('p1')).toBeNull()
  })
})

describe('backgroundWork', () => {
  it('keeps a pane with a running subagent, whatever its processes look like', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { subagentStarted: 'a' })
    expect(backgroundWork(work.reason('p1'), idleAgent, SHELL)).toBe('subagent')
  })

  it('keeps a pane whose agent left a background shell, with nothing reported', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { turnEnded: true, tasks: 0, scheduled: 0 })
    expect(backgroundWork(work.reason('p1'), backgroundShell, SHELL)).toBe('child-process')
  })

  it('lets a pane hibernate only when neither signal reports work', () => {
    const work = new ReportedAgentWork()
    work.report('p1', { turnEnded: true, tasks: 0, scheduled: 0 })
    expect(backgroundWork(work.reason('p1'), idleAgent, SHELL)).toBeNull()
    expect(backgroundWork(null, idleAgent, SHELL)).toBeNull()
  })

  it('keeps a pane when the processes cannot be read', () => {
    expect(backgroundWork(null, null, SHELL)).toBe('unknown')
  })
})
