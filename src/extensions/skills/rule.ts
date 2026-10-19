export const RULE_MAX = 160
export const WHY_MAX = 300
export const WHEN_MAX = 200
export const RULES_CONTEXT_MAX_RULES = 40
export const RULES_CONTEXT_MAX = 6000

type RuleState = 'active' | 'retired'
export type RuleOrigin = 'human' | 'import'

export interface Rule {
  id: string
  rule: string
  why: string
  when: string
  scope: string
  state: RuleState
  origin: RuleOrigin
  createdAt: number
}

export interface RuleDraft {
  rule: string
  why: string
  when: string
  scope: string
}

export interface RulesFile {
  next: number
  rules: Rule[]
}

const SCOPE_PATTERN = /^(global|stack:[a-z0-9._+-]{1,40}|project:\S{1,300})$/

export function isScope(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_PATTERN.test(value)
}

export function parseRulesFile(text: string): RulesFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { next: 1, rules: [] }
  }
  const obj = (raw ?? {}) as { next?: unknown; rules?: unknown }
  const rules = (Array.isArray(obj.rules) ? obj.rules : []).filter(isStoredRule)
  const highest = rules.reduce((max, r) => Math.max(max, Number(r.id.slice(1))), 0)
  const next = typeof obj.next === 'number' && obj.next > highest ? obj.next : highest + 1
  return { next, rules }
}

function isStoredRule(value: unknown): value is Rule {
  const r = value as Partial<Rule> | null
  return (
    typeof r?.id === 'string' &&
    /^r\d{1,9}$/.test(r.id) &&
    typeof r.rule === 'string' &&
    typeof r.why === 'string' &&
    typeof r.when === 'string' &&
    isScope(r.scope) &&
    (r.state === 'active' || r.state === 'retired') &&
    (r.origin === 'human' || r.origin === 'import') &&
    typeof r.createdAt === 'number'
  )
}
