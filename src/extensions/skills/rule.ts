export const RULE_MAX = 160
export const WHY_MAX = 300
export const WHEN_MAX = 200
export const RULES_CONTEXT_MAX_RULES = 40
export const RULES_CONTEXT_MAX = 6000

export type RuleState = 'proposed' | 'active' | 'retired'
export type RuleOrigin = 'human' | 'import' | 'extraction'

export interface Rule {
  id: string
  rule: string
  why: string
  when: string
  scope: string
  state: RuleState
  origin: RuleOrigin
  createdAt: number
  approvedAt?: number
  evidence?: string[]
  conflicts?: string[]
}

export interface RuleDraft {
  rule: string
  why: string
  when: string
  scope: string
}

export interface StoredGroup {
  id: string
  signals: string[]
  words: string[]
}

export interface RulesFile {
  next: number
  rules: Rule[]
  groups: StoredGroup[]
  dismissed: string[]
}

const SCOPE_PATTERN = /^(global|stack:[a-z0-9._+-]{1,40}|project:\S{1,300})$/

export function isScope(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_PATTERN.test(value)
}

export function parseRulesFile(text: string): RulesFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const obj = raw as {
    next?: unknown
    rules?: unknown
    groups?: unknown
    dismissed?: unknown
  } | null
  if (!obj || !Array.isArray(obj.rules) || !obj.rules.every(isStoredRule)) return null
  const groups = obj.groups ?? []
  const dismissed = obj.dismissed ?? []
  if (!Array.isArray(groups) || !groups.every(isStoredGroup) || !isStrings(dismissed)) return null
  const rules = obj.rules
  const highest = rules.reduce((max, r) => Math.max(max, Number(r.id.slice(1))), 0)
  const next = typeof obj.next === 'number' && obj.next > highest ? obj.next : highest + 1
  return { next, rules, groups, dismissed }
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isStoredGroup(value: unknown): value is StoredGroup {
  const g = value as Partial<StoredGroup> | null
  return typeof g?.id === 'string' && isStrings(g.signals) && isStrings(g.words)
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
    (r.state === 'proposed' || r.state === 'active' || r.state === 'retired') &&
    (r.origin === 'human' || r.origin === 'import' || r.origin === 'extraction') &&
    typeof r.createdAt === 'number' &&
    (r.approvedAt === undefined || typeof r.approvedAt === 'number') &&
    (r.evidence === undefined || isStrings(r.evidence)) &&
    (r.conflicts === undefined || isStrings(r.conflicts))
  )
}
