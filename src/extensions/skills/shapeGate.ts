import { RULE_MAX, type RuleDraft, WHEN_MAX, WHY_MAX } from './rule'

export type ShapeProblem =
  | 'empty'
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
  /\bpermissions?\b/i,
  /\bapprovals?\b/i,
  /\bapprove\b/i,
  /\bsandbox(?:es|ed)?\b/i,
  /\bhooks?\b/i,
  /\bcapabilit(?:y|ies)\b/i,
  /\bpermission modes?\b/i,
  /--dangerously/i,
  /\bbypass/i,
  /\bskip(?:ping)? (?:the )?(?:confirmation|approval|prompts?)\b/i,
  /\bwithout (?:asking|confirmation|approval)\b/i,
  /\bauto-?approv/i,
  /\bignore (?:all |any )?(?:previous|prior|system|above)\b/i,
]

const ABOUT_OSTIA = [
  /\bostia\b/i,
  /\bother agents?\b/i,
  /\b(?:CLAUDE|AGENTS)\.md\b/,
  /\bsystem prompt\b/i,
  /\brules? (?:of|for) (?:other|another)\b/i,
]

const COMMAND_START =
  /^\s*(?:\$ |sudo |(?:git|npm|pnpm|yarn|npx|pip|uv|cargo|go|docker|kubectl|curl|wget|rm|cd|ls|cat|chmod|make|brew|apt) [^\s])/
const PATH_TOKEN = /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]*)*/
const URL = /\b(?:https?|ftp|ssh|git):\/\/|\bwww\./i
const NUMBERED = /(?:^|\n)\s*(?:\d+[.)]|[-*•]\s)/
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs)\./gi

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
  if (!rule) problems.add('empty')
  if (draft.rule.length > RULE_MAX || draft.why.length > WHY_MAX || draft.when.length > WHEN_MAX) {
    problems.add('too-long')
  }
  if (opts.secret) problems.add('secret')
  if (fields.some((f) => URL.test(f))) problems.add('url')
  if (fields.some((f) => /OSTIA_[A-Z0-9_]*/.test(f))) problems.add('ostia-name')
  if (fields.some((f) => CAPABILITY_WORDS.some((re) => re.test(f)))) problems.add('capability')
  if (fields.some((f) => ABOUT_OSTIA.some((re) => re.test(f)))) problems.add('about-ostia')
  if (/\n/.test(rule) || NUMBERED.test(rule) || sentenceCount(rule) > 1) problems.add('steps')
  if (COMMAND_START.test(rule) || /^`[^`]+`$/.test(rule)) problems.add('command')
  if (!draft.scope.startsWith('project:') && fields.some((f) => PATH_TOKEN.test(f))) {
    problems.add('path')
  }
  return [...problems]
}
