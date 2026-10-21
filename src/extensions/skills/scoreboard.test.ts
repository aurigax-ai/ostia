import { describe, expect, it } from 'vitest'
import type { Applied } from './applied'
import type { Rule } from './rule'
import { beforeCounts, ENOUGH_SESSIONS, scoreboard, WINDOW_MS } from './scoreboard'
import type { Signal } from './signal'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const APPROVED = NOW - 10 * DAY

const rule = (extra: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  rule: 'Write no comments in code.',
  why: '',
  when: '',
  scope: 'global',
  state: 'active',
  origin: 'human',
  createdAt: APPROVED,
  approvedAt: APPROVED,
  ...extra,
})

let seq = 0
const prompt = (
  text: string,
  at: number,
  session: string,
  extra: Partial<Signal> = {},
): Signal => ({
  id: `s${++seq}`,
  at,
  kind: 'prompt',
  agent: 'claude',
  text,
  session,
  pane: 'p',
  workspace: 'w',
  project: null,
  stacks: [],
  ...extra,
})

const applied = (session: string, extra: Partial<Applied> = {}): Applied => ({
  at: NOW - DAY,
  session,
  workspace: 'w',
  rules: ['r1'],
  held: [],
  ...extra,
})

const ASK = 'No comments in the code, I told you.'
const PLAIN = 'Add a retry helper to the client.'

describe('scoreboard', () => {
  it('counts sessions the rule was given in, once each, and the last time', () => {
    const [row] = scoreboard({
      rules: [rule()],
      signals: [],
      applied: [
        applied('a', { at: 5 * DAY }),
        applied('a', { at: 7 * DAY }),
        applied('b', { at: 9 * DAY }),
        applied('c', { rules: [] }),
      ],
      now: NOW,
    })
    expect(row.applied).toBe(2)
    expect(row.lastApplied).toBe(9 * DAY)
  })

  it('counts a later prompt that says the rule again, in a session the rule was given in', () => {
    const [row] = scoreboard({
      rules: [rule()],
      signals: [
        prompt(ASK, NOW - 2 * DAY, 'a'),
        prompt(ASK, NOW - 2 * DAY, 'b'),
        prompt(PLAIN, NOW - 2 * DAY, 'a'),
        prompt('Never use npm here.', NOW - 2 * DAY, 'a'),
        prompt(ASK, APPROVED - DAY, 'a'),
      ],
      applied: [applied('a')],
      now: NOW,
    })
    expect(row.restated).toBe(1)
  })

  it('compares the sessions before approval with the sessions since, with an interval', () => {
    const before = [
      ...Array.from({ length: 4 }, (_, i) => prompt(ASK, APPROVED - (i + 1) * DAY, `b${i}`)),
      ...Array.from({ length: 6 }, (_, i) => prompt(PLAIN, APPROVED - (i + 5) * DAY, `n${i}`)),
    ]
    const after = [
      prompt(ASK, NOW - DAY, 'x0'),
      ...Array.from({ length: 9 }, (_, i) => prompt(PLAIN, NOW - (i + 1) * 0.5 * DAY, `x${i + 1}`)),
    ]
    const [row] = scoreboard({
      rules: [rule()],
      signals: [...before, ...after],
      applied: [],
      now: NOW,
    })
    expect(row.before).toMatchObject({ sessions: 10, restated: 4 })
    expect(row.after).toMatchObject({ sessions: 10, restated: 1 })
    expect(row.before.rate).toBeCloseTo(0.4)
    expect(row.after.low).toBeLessThan(row.after.rate)
    expect(row.after.high).toBeGreaterThan(row.after.rate)
    expect(row.enough).toBe(true)
  })

  it('keeps the before-rate stored at approval when the signals behind it are gone', () => {
    const after = Array.from({ length: 10 }, (_, i) =>
      prompt(PLAIN, NOW - (i + 1) * 0.5 * DAY, `x${i}`),
    )
    const [row] = scoreboard({
      rules: [rule({ before: { sessions: 12, restated: 6 } })],
      signals: after,
      applied: [],
      now: NOW,
    })
    expect(row.before).toMatchObject({ sessions: 12, restated: 6 })
    expect(row.enough).toBe(true)
  })

  it('computes the before-counts to store from the window before approval', () => {
    const signals = [
      prompt(ASK, APPROVED - DAY, 'a'),
      prompt(PLAIN, APPROVED - 2 * DAY, 'b'),
      prompt(ASK, APPROVED - 31 * DAY, 'old'),
    ]
    expect(beforeCounts(rule(), signals)).toEqual({ sessions: 2, restated: 1 })
  })

  it('says there is not enough data below ten sessions on either side', () => {
    const sessions = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => prompt(PLAIN, from + i * 1000, `s${seq}-${from}-${i}`))
    const row = (before: number, after: number) =>
      scoreboard({
        rules: [rule()],
        signals: [...sessions(before, APPROVED - 3 * DAY), ...sessions(after, APPROVED + DAY)],
        applied: [],
        now: NOW,
      })[0]
    expect(row(ENOUGH_SESSIONS, ENOUGH_SESSIONS).enough).toBe(true)
    expect(row(ENOUGH_SESSIONS - 1, ENOUGH_SESSIONS).enough).toBe(false)
    expect(row(ENOUGH_SESSIONS, ENOUGH_SESSIONS - 1).enough).toBe(false)
  })

  it('looks only 30 days back and only at sessions where the rule applies', () => {
    const [row] = scoreboard({
      rules: [rule({ scope: 'project:github.com/a/b' })],
      signals: [
        prompt(ASK, APPROVED - WINDOW_MS - DAY, 'old', { project: 'project:github.com/a/b' }),
        prompt(ASK, APPROVED - DAY, 'elsewhere', { project: 'project:github.com/c/d' }),
        prompt(ASK, APPROVED - DAY, 'here', { project: 'project:github.com/a/b' }),
      ],
      applied: [],
      now: NOW,
    })
    expect(row.before.sessions).toBe(1)
  })

  it('matches a stack rule to prompts from that stack', () => {
    const [row] = scoreboard({
      rules: [rule({ rule: 'Use pnpm, never npm.', scope: 'stack:node' })],
      signals: [
        prompt('Use pnpm, never npm.', NOW - DAY, 'a', { stacks: ['node'] }),
        prompt('Use pnpm, never npm.', NOW - DAY, 'b', { stacks: ['go'] }),
      ],
      applied: [],
      now: NOW,
    })
    expect(row.after).toMatchObject({ sessions: 1, restated: 1 })
  })

  it('leaves out prompts with no session and rules that are not active', () => {
    const rows = scoreboard({
      rules: [rule(), rule({ id: 'r2', state: 'retired' }), rule({ id: 'r3', state: 'proposed' })],
      signals: [prompt(ASK, NOW - DAY, '')],
      applied: [],
      now: NOW,
    })
    expect(rows.map((r) => r.id)).toEqual(['r1'])
    expect(rows[0].after.sessions).toBe(0)
  })

  it('compares sessions the rule was left out of with sessions it was given in, when some were left out', () => {
    const signals = [
      prompt(ASK, NOW - DAY, 'held1'),
      prompt(PLAIN, NOW - DAY, 'held2'),
      prompt(PLAIN, NOW - DAY, 'given1'),
      prompt(PLAIN, NOW - DAY, 'given2'),
    ]
    const [none] = scoreboard({ rules: [rule()], signals, applied: [applied('given1')], now: NOW })
    expect(none.holdout).toBeNull()
    const [row] = scoreboard({
      rules: [rule()],
      signals,
      applied: [
        applied('given1'),
        applied('given2'),
        applied('held1', { rules: [], held: ['r1'] }),
        applied('held2', { rules: [], held: ['r1'] }),
      ],
      now: NOW,
    })
    expect(row.holdout?.held).toMatchObject({ sessions: 2, restated: 1 })
    expect(row.holdout?.given).toMatchObject({ sessions: 2, restated: 0 })
  })
})
