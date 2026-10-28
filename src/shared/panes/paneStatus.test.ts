import { describe, expect, it } from 'vitest'
import { ageLabel, type PaneStatus, statusLine } from './paneStatus'

const base: PaneStatus = {
  pane: 'p1',
  title: 'w-3',
  state: 'done',
  sinceMs: 2 * 60_000 + 5000,
  closing: 'PR #1081 open, unit green',
  exitCode: 0,
  git: { branch: 'feat/inbox', ahead: 1, behind: 0, changed: 2 },
  mail: { queued: 0, failed: 0, sentQueued: 0, sentFailed: 0 },
  stale: [],
  conflict: [],
  changes: {
    first: false,
    states: ['working', 'done'],
    commands: 3,
    failed: 0,
    closing: true,
    mail: 0,
  },
}

describe('ageLabel', () => {
  it('counts seconds, minutes, hours and days', () => {
    expect([0, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000 * 3].map(ageLabel)).toEqual([
      '0s',
      '59s',
      '1m',
      '59m',
      '1h',
      '3d',
    ])
  })

  it('never goes below zero', () => {
    expect(ageLabel(-5000)).toBe('0s')
  })
})

describe('statusLine', () => {
  it('puts state, age, exit code, git, mail, the closing line and what changed on one line', () => {
    expect(statusLine(base)).toBe(
      'p1  w-3  done 2m  exit 0  feat/inbox +2 ↑1  mail 0  "PR #1081 open, unit green"  (since last: working→done, 3 commands, 0 failed, new closing line)',
    )
  })

  it('marks a kept-awake pane after its state', () => {
    expect(statusLine({ ...base, keepAwake: true })).toContain('exit 0  keep-awake  feat/inbox')
  })

  it('says first look the first time, and no change when nothing happened', () => {
    expect(statusLine({ ...base, changes: { ...base.changes, first: true } })).toContain(
      '(first look)',
    )
    expect(
      statusLine({
        ...base,
        changes: { first: false, states: [], commands: 0, failed: 0, closing: false, mail: 0 },
      }),
    ).toContain('(no change since last)')
  })

  it('leaves out what it does not know and shows failed mail and a process', () => {
    const line = statusLine({
      ...base,
      sinceMs: undefined,
      closing: undefined,
      exitCode: undefined,
      git: undefined,
      process: { id: 'web', status: 'running' },
      mail: { queued: 2, failed: 1, sentQueued: 0, sentFailed: 0 },
    })
    expect(line).toContain('w-3  done  process web running  mail 2 failed 1  (')
    expect(line).not.toContain('exit')
  })

  it('lists what has been stuck, and nothing when nothing is', () => {
    expect(statusLine(base)).not.toContain('stale')
    expect(statusLine({ ...base, stale: ['mail queued 38m', 'waking 3m'] })).toContain(
      '"PR #1081 open, unit green"  stale: mail queued 38m, waking 3m  (since last',
    )
  })

  it('names the panes that share its worktree, and leaves it out when none do', () => {
    expect(statusLine(base)).not.toContain('conflict')
    expect(statusLine({ ...base, conflict: ['w-4', 'w-5'] })).toContain('conflict: w-4, w-5')
  })

  it('names a detached head and shows behind commits', () => {
    expect(
      statusLine({ ...base, git: { branch: null, ahead: 0, behind: 3, changed: 0 } }),
    ).toContain('detached ↓3')
  })
})
