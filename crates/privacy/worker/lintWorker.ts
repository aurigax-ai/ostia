import { createInterface } from 'node:readline'
import { lintSource } from '@secretlint/core'
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend'

type LintConfig = Parameters<typeof lintSource>[0]['options']['config']
type LintRule = LintConfig['rules'][number]

interface Request {
  id: number
  content?: string
  kinds?: boolean
}

const RULE_PREFIX = '@secretlint/secretlint-rule-'
const COMMENT_FILTER_RULE = `${RULE_PREFIX}filter-comments`
const RULE_OPTIONS: Record<string, Record<string, unknown>> = {
  [`${RULE_PREFIX}aws`]: { enableIDScanRule: true },
}
const SOURCE_NAME = 'text.txt'

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

async function reply(request: Request): Promise<Record<string, unknown>> {
  if (request.kinds) {
    return {
      id: request.id,
      rules: scanners.map((rule) => ({
        ruleId: rule.meta.id,
        messages: Object.keys(rule.messages),
      })),
    }
  }
  const result = await lintSource({
    source: {
      filePath: SOURCE_NAME,
      content: request.content ?? '',
      ext: '.txt',
      contentType: 'text',
    },
    options: { config, noPhysicFilePath: true },
  })
  return {
    id: request.id,
    messages: result.messages.map((message) => ({
      ruleId: message.ruleId,
      range: message.range,
      data: message.data,
    })),
  }
}

let pending: Promise<void> = Promise.resolve()

createInterface({ input: process.stdin }).on('line', (line) => {
  pending = pending.then(async () => {
    let id: number | null = null
    let body: Record<string, unknown>
    try {
      const request = JSON.parse(line) as Request
      id = request.id
      body = await reply(request)
    } catch (error) {
      body = { id, error: error instanceof Error ? error.message : 'scan failed' }
    }
    process.stdout.write(`${JSON.stringify(body)}\n`)
  })
})
