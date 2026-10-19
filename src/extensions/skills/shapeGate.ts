import { RULE_MAX, type RuleDraft, WHEN_MAX, WHY_MAX } from './rule'

export type ShapeProblem =
  | 'empty'
  | 'control'
  | 'confusable'
  | 'too-long'
  | 'steps'
  | 'command'
  | 'path'
  | 'url'
  | 'secret'
  | 'ostia-name'
  | 'capability'
  | 'about-ostia'

const CAPABILITY_WORDS = [
  /permission/,
  /approv/,
  /confirm/,
  /consent/,
  /authori[sz]/,
  /sandbox/,
  /\bhooks?\b/,
  /capabilit/,
  /bypass/,
  /safety|safeguard|guardrail/,
  /\bask(?:s|ed|ing)?\b/,
  /\bsettings?\b/,
  /\.(?:claude|codex|ostia)\b|settings\.json|config\.toml/,
  /--dangerously|\bdangerous/,
  /\byolo\b|full[- ]?auto|auto[- ]?(?:accept|allow|run|execute|approv)/,
  /\bunrestricted\b|\bunattended\b/,
  /\b(?:any|every|all|arbitrary) (?:(?:shell|bash) )?(?:commands?|tools?)\b/,
  /\b(?:disable|turn off|skip|override|ignore|circumvent|disregard|evade|suppress)\b(?:\W+\w+){0,4}?\W+(?:checks?|security|restrictions?|limits?|prompts?|warnings?|protections?|polic(?:y|ies)|instructions?|rules?|guards?)\b/,
]

const ABOUT_OSTIA = [
  /\bostia\b/,
  /\bother agents?\b/,
  /\b(?:claude|agents)\.md\b/,
  /system prompt/,
  /\brules? (?:of|for) (?:other|another)\b/,
]

const COMMAND_START =
  /^\s*(?:\$ |sudo |(?:git|npm|pnpm|yarn|npx|pip|uv|cargo|go|docker|kubectl|curl|wget|rm|cd|ls|cat|chmod|make|brew|apt) [^\s])/
const PATH_TOKEN = /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]*)*/
const URL = /\b(?:https?|ftp|ssh|git):\/\/|\bwww\./i
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const MIXED_SCRIPT =
  /\p{Script=Latin}[\p{Script=Cyrillic}\p{Script=Greek}]|[\p{Script=Cyrillic}\p{Script=Greek}]\p{Script=Latin}/u
const NUMBERED = /(?:^|\n)\s*(?:\d+[.)]|[-*•]\s)/
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs)\./gi

function folded(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
}

function sentenceCount(text: string): number {
  return text
    .replace(ABBREVIATION, (m) => m.replaceAll('.', ''))
    .split(/(?<=[.!?。！？])\s+(?=\S)/)
    .filter((s) => s.trim()).length
}

export function shapeGate(draft: RuleDraft, opts: { secret: boolean }): ShapeProblem[] {
  const problems = new Set<ShapeProblem>()
  const rule = draft.rule.trim()
  const fields = [draft.rule, draft.why, draft.when]
  const seen = fields.map(folded)
  if (!rule) problems.add('empty')
  if (draft.rule.length > RULE_MAX || draft.why.length > WHY_MAX || draft.when.length > WHEN_MAX) {
    problems.add('too-long')
  }
  if (opts.secret) problems.add('secret')
  if (fields.some((f) => CONTROL.test(f))) problems.add('control')
  if (fields.some((f) => MIXED_SCRIPT.test(f))) problems.add('confusable')
  if (seen.some((f) => URL.test(f))) problems.add('url')
  if (fields.some((f) => /OSTIA_[A-Z0-9_]*/i.test(folded(f)))) problems.add('ostia-name')
  if (seen.some((f) => CAPABILITY_WORDS.some((re) => re.test(f)))) problems.add('capability')
  if (seen.some((f) => ABOUT_OSTIA.some((re) => re.test(f)))) problems.add('about-ostia')
  if (NUMBERED.test(rule) || sentenceCount(rule) > 1) problems.add('steps')
  if (COMMAND_START.test(rule) || /^`[^`]+`$/.test(rule)) problems.add('command')
  if (!draft.scope.startsWith('project:') && seen.some((f) => PATH_TOKEN.test(f))) {
    problems.add('path')
  }
  return [...problems]
}
