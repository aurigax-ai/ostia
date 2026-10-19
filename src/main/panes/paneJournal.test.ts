import { describe, expect, it } from 'vitest'
import { JOURNAL_CURSORS_MAX, JOURNAL_EVENTS_MAX, PaneJournal } from './paneJournal'

function journal() {
  const clock = { now: 1000 }
  const terminal = new Map<string, { running: boolean; lastExitCode?: number }>()
  const j = new PaneJournal({ terminal: (id) => terminal.get(id), now: () => clock.now })
  return { j, clock, terminal }
}

const attention = (state?: string) => ({ kind: 'attention' as const, attention: { state } })

describe('PaneJournal state', () => {
  it('records a transition once, with the state it left and when it began', () => {
    const { j, clock } = journal()
    j.onChange('p', attention('working'))
    clock.now = 5000
    j.onChange('p', attention('working'))
    j.onChange('p', attention('done'))
    expect(j.stateSince('p')).toBe(5000)
    const seen = j.changes('me', 'p')
    expect(seen).toEqual({ first: true })
    clock.now = 6000
    j.onChange('p', attention('working'))
    const next = j.changes('me', 'p')
    expect(next).toMatchObject({
      first: false,
      events: [{ kind: 'state', state: 'working', from: 'done' }],
    })
  })

  it('reads a cleared attention as idle', () => {
    const { j } = journal()
    j.onChange('p', attention('done'))
    j.onChange('p', attention(undefined))
    j.changes('me', 'p')
    j.onChange('p', attention('working'))
    expect(j.changes('me', 'p')).toMatchObject({ events: [{ state: 'working', from: 'idle' }] })
  })
})

describe('PaneJournal commands', () => {
  it('records a finished command with its exit code and ignores one that is still running', () => {
    const { j, terminal } = journal()
    terminal.set('p', { running: true })
    j.onChange('p', { kind: 'state' })
    j.changes('me', 'p')
    terminal.set('p', { running: false, lastExitCode: 2 })
    j.onChange('p', { kind: 'state' })
    j.onChange('p', { kind: 'state' })
    expect(j.changes('me', 'p')).toMatchObject({ events: [{ kind: 'command', exitCode: 2 }] })
  })

  it('records nothing for a pane that has no terminal state', () => {
    const { j } = journal()
    j.onChange('p', { kind: 'state' })
    expect(j.changes('me', 'p')).toEqual({ first: true })
    expect(j.changes('me', 'p')).toMatchObject({ events: [] })
  })
})

describe('PaneJournal subscribe', () => {
  it('tells a listener each event as it is recorded, with its pane', () => {
    const { j, terminal } = journal()
    const heard: [string, string][] = []
    j.subscribe((paneId, event) => heard.push([paneId, event.kind]))
    j.onChange('p', { kind: 'attention', attention: { state: 'done' } })
    terminal.set('p', { running: true })
    j.onChange('p', { kind: 'state' })
    terminal.set('p', { running: false, lastExitCode: 0 })
    j.onChange('p', { kind: 'state' })
    j.mail('p')
    expect(heard).toEqual([
      ['p', 'state'],
      ['p', 'command'],
      ['p', 'mail'],
    ])
  })
})

describe('PaneJournal closing line', () => {
  it('prefers the line the agent set over the Stop text, and keeps both until the next turn', () => {
    const { j } = journal()
    j.report('p', 'done', undefined, 'stop text')
    expect(j.closing('p')).toBe('stop text')
    j.report('p', 'done', 'PR #4 open\nmore', 'stop text')
    expect(j.closing('p')).toBe('PR #4 open')
    j.report('p', 'done', undefined, 'later stop text')
    expect(j.closing('p')).toBe('PR #4 open')
    j.onChange('p', attention('working'))
    expect(j.closing('p')).toBeUndefined()
  })

  it('takes a closing line only from a done report', () => {
    const { j } = journal()
    j.report('p', 'waiting', 'Allow Bash?', 'text')
    j.report('p', 'error', 'boom', undefined)
    expect(j.closing('p')).toBeUndefined()
  })
})

describe('PaneJournal changes', () => {
  it('answers first look, then only what is new for that caller', () => {
    const { j } = journal()
    j.mail('p')
    expect(j.changes('a', 'p')).toEqual({ first: true })
    j.mail('p')
    expect(j.changes('b', 'p')).toEqual({ first: true })
    expect(j.changes('a', 'p')).toMatchObject({ first: false, events: [{ kind: 'mail' }] })
    expect(j.changes('a', 'p')).toMatchObject({ first: false, events: [] })
    expect(j.changes('b', 'p')).toMatchObject({ first: false, events: [] })
    j.mail('p')
    expect(j.changes('b', 'p')).toMatchObject({ first: false, events: [{ kind: 'mail' }] })
    expect(j.changes('a', 'p')).toMatchObject({ first: false, events: [{ kind: 'mail' }] })
  })

  it('keeps the last twenty events of a pane', () => {
    const { j } = journal()
    j.changes('a', 'p')
    for (let i = 0; i < JOURNAL_EVENTS_MAX + 5; i++) j.mail('p')
    const seen = j.changes('a', 'p')
    expect(seen.first === false && seen.events).toHaveLength(JOURNAL_EVENTS_MAX)
  })

  it('bounds the cursors it keeps, dropping the one looked at longest ago', () => {
    const { j } = journal()
    j.changes('first', 'p')
    for (let i = 0; i < JOURNAL_CURSORS_MAX; i++) j.changes(`caller-${i}`, 'p')
    expect(j.changes('first', 'p')).toEqual({ first: true })
    expect(j.changes(`caller-${JOURNAL_CURSORS_MAX - 1}`, 'p')).toMatchObject({ first: false })
  })

  it('forgets a closed pane, its closing line and every cursor that pointed at it', () => {
    const { j } = journal()
    j.report('p', 'done', 'PR', undefined)
    j.changes('a', 'p')
    j.changes('p-ext', 'q')
    j.onChange('p', { kind: 'closed' })
    expect(j.closing('p')).toBeUndefined()
    expect(j.changes('a', 'p')).toEqual({ first: true })
    j.forget('other', 'p-ext')
    expect(j.changes('p-ext', 'q')).toEqual({ first: true })
  })
})

describe('PaneJournal since', () => {
  it('PHA-C7 marks when the agent state, running or hibernation last changed', () => {
    const { j, clock, terminal } = journal()
    expect(j.since('p')).toBeUndefined()
    j.onChange('p', attention('working'))
    expect(j.since('p')).toBe(1000)
    clock.now = 2000
    j.onChange('p', attention('working'))
    expect(j.since('p')).toBe(1000)
    terminal.set('p', { running: true })
    j.onChange('p', { kind: 'state' })
    expect(j.since('p')).toBe(2000)
    clock.now = 3000
    j.onChange('p', { kind: 'state' })
    expect(j.since('p')).toBe(2000)
    clock.now = 4000
    j.lifecycle('p')
    expect(j.since('p')).toBe(4000)
    j.onChange('p', { kind: 'closed' })
    expect(j.since('p')).toBeUndefined()
  })
})
