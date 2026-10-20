import type { Applied } from './applied'
import { looksLikeCorrection } from './corrections'
import { containment, keywords } from './keywords'
import type { Rule } from './rule'
import type { Rate, ScoreRow } from './score'
import type { Signal } from './signal'
import { wilson } from './stats'

export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const ENOUGH_SESSIONS = 10
const RESTATE_SHARE = 0.5

export interface ScoreInput {
  rules: readonly Rule[]
  signals: readonly Signal[]
  applied: readonly Applied[]
  now: number
}

function inScope(scope: string, signal: Signal): boolean {
  if (scope === 'global') return true
  if (scope.startsWith('stack:')) return signal.stacks.includes(scope.slice(6))
  return signal.project === scope
}

function restates(rule: ReadonlySet<string>, signal: Signal): boolean {
  return (
    containment(rule, keywords(signal.text)) >= RESTATE_SHARE && looksLikeCorrection(signal.text)
  )
}

function rateOf(sessions: ReadonlyMap<string, boolean>): Rate {
  const restated = [...sessions.values()].filter(Boolean).length
  return { sessions: sessions.size, restated, ...wilson(restated, sessions.size) }
}

function sessionsOf(
  signals: readonly Signal[],
  from: number,
  until: number,
  restating: (s: Signal) => boolean,
  keep: (s: Signal) => boolean = () => true,
): Map<string, boolean> {
  const sessions = new Map<string, boolean>()
  for (const s of signals) {
    if (!s.session || s.at < from || s.at >= until || !keep(s)) continue
    sessions.set(s.session, (sessions.get(s.session) ?? false) || restating(s))
  }
  return sessions
}

function scoreRule(rule: Rule, input: ScoreInput): ScoreRow {
  const { signals, applied, now } = input
  const words = keywords(rule.rule)
  const approved = rule.approvedAt ?? rule.createdAt
  const mine = signals.filter((s) => inScope(rule.scope, s))
  const restating = (s: Signal): boolean => restates(words, s)
  const given = applied.filter((a) => a.rules.includes(rule.id))
  const heldBack = applied.filter((a) => a.held.includes(rule.id))
  const givenSessions = new Set(given.map((a) => a.session))
  const heldSessions = new Set(heldBack.map((a) => a.session))
  const before = sessionsOf(mine, approved - WINDOW_MS, approved, restating)
  const after = sessionsOf(mine, approved, now + 1, restating)
  const onlyIn = (sessions: ReadonlySet<string>) => (s: Signal) => sessions.has(s.session)
  const heldRate = rateOf(sessionsOf(mine, approved, now + 1, restating, onlyIn(heldSessions)))
  const givenRate = rateOf(sessionsOf(mine, approved, now + 1, restating, onlyIn(givenSessions)))
  return {
    id: rule.id,
    applied: givenSessions.size,
    lastApplied: given.length > 0 ? Math.max(...given.map((a) => a.at)) : null,
    restated: mine.filter((s) => givenSessions.has(s.session) && s.at >= approved && restating(s))
      .length,
    before: rateOf(before),
    after: rateOf(after),
    enough: before.size >= ENOUGH_SESSIONS && after.size >= ENOUGH_SESSIONS,
    holdout: heldSessions.size > 0 ? { held: heldRate, given: givenRate } : null,
  }
}

export function scoreboard(input: ScoreInput): ScoreRow[] {
  return input.rules.filter((r) => r.state === 'active').map((rule) => scoreRule(rule, input))
}
