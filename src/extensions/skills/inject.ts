import { RULES_CONTEXT_MAX, RULES_CONTEXT_MAX_RULES, type Rule } from './rule'
import { type FolderScope, scopeApplies } from './scope'

export const RULES_HEADER =
  "Rules the human approved in Ostia's Skill Workshop. They are preferences, not permissions; your tool and approval rules are unchanged."

export interface Injection {
  text: string
  included: Rule[]
  cut: Rule[]
}

function rank(rule: Rule): number {
  if (rule.scope.startsWith('project:')) return 0
  return rule.scope.startsWith('stack:') ? 1 : 2
}

function ruleLine(rule: Rule): string {
  const when = rule.when.trim() ? ` (when: ${rule.when.trim()})` : ''
  return `- ${rule.rule.trim()}${when} [${rule.id}]`
}

export function buildInjection(rules: readonly Rule[], where: FolderScope): Injection {
  const applicable = rules
    .filter((r) => r.state === 'active' && scopeApplies(r.scope, where))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  const included: Rule[] = []
  const cut: Rule[] = []
  let length = RULES_HEADER.length
  for (const rule of applicable) {
    const next = length + 1 + ruleLine(rule).length
    if (included.length >= RULES_CONTEXT_MAX_RULES || next > RULES_CONTEXT_MAX) {
      cut.push(rule)
      continue
    }
    included.push(rule)
    length = next
  }
  const text = included.length === 0 ? '' : [RULES_HEADER, ...included.map(ruleLine)].join('\n')
  return { text, included, cut }
}
