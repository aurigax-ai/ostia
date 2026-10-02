import { lintSource } from '@secretlint/core'
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend'
import type { RedactionKindInfo, SecretSpan } from '../shared/redaction'

type LintConfig = Parameters<typeof lintSource>[0]['options']['config']
type LintRule = LintConfig['rules'][number]
type LintMessage = Awaited<ReturnType<typeof lintSource>>['messages'][number]

const RULE_PREFIX = '@secretlint/secretlint-rule-'
const COMMENT_FILTER_RULE = `${RULE_PREFIX}filter-comments`
const RULE_OPTIONS: Record<string, Record<string, unknown>> = {
  [`${RULE_PREFIX}aws`]: { enableIDScanRule: true },
}
const SOURCE_NAME = 'text.txt'
const REPORTED_VALUE_MIN = 8
export const SCAN_CHUNK_MAX = 1024 * 1024

const scanners = recommendedRules.filter((rule) => rule.meta.id !== COMMENT_FILTER_RULE)

const config: LintConfig = {
  rules: scanners.map(
    (rule) =>
      ({
        id: rule.meta.id,
        rule,
        options: RULE_OPTIONS[rule.meta.id] ?? {},
      }) as unknown as LintRule,
  ),
}

export function kindOfRule(ruleId: string): string {
  const name = ruleId.startsWith(RULE_PREFIX) ? ruleId.slice(RULE_PREFIX.length) : ruleId
  const kind = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return kind || 'secret'
}

export function libraryKinds(): RedactionKindInfo[] {
  return scanners.map((rule) => ({
    kind: kindOfRule(rule.meta.id),
    source: 'library',
    detects: Object.keys(rule.messages),
  }))
}

function reportedValues(message: LintMessage): string[] {
  const data: unknown = message.data
  if (typeof data !== 'object' || data === null) return []
  return Object.values(data).filter(
    (value): value is string => typeof value === 'string' && value.length >= REPORTED_VALUE_MIN,
  )
}

function spansOf(text: string, message: LintMessage, offset: number): SecretSpan[] {
  const kind = kindOfRule(message.ruleId)
  const [start, end] = message.range
  const exact: SecretSpan[] = []
  for (const value of reportedValues(message)) {
    const at = text.indexOf(value, start)
    if (at === -1 || at > end) continue
    exact.push({ start: offset + at, end: offset + at + value.length, kind })
  }
  return exact.length > 0 ? exact : [{ start: offset + start, end: offset + end, kind }]
}

function chunkEnd(text: string, start: number): number {
  const limit = start + SCAN_CHUNK_MAX
  if (limit >= text.length) return text.length
  const newline = text.lastIndexOf('\n', limit)
  return newline > start ? newline + 1 : limit
}

export async function scanSecrets(text: string): Promise<SecretSpan[]> {
  const spans: SecretSpan[] = []
  let start = 0
  while (start < text.length) {
    const end = chunkEnd(text, start)
    const content = start === 0 && end === text.length ? text : text.slice(start, end)
    const result = await lintSource({
      source: { filePath: SOURCE_NAME, content, ext: '.txt', contentType: 'text' },
      options: { config, noPhysicFilePath: true },
    })
    for (const message of result.messages) spans.push(...spansOf(content, message, start))
    start = end
  }
  return spans
}
