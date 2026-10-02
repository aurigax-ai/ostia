import { lintSource } from '@secretlint/core'
import { rules } from '@secretlint/secretlint-rule-preset-recommend'

const result = await lintSource({
  source: {
    filePath: 'text.txt',
    content: `token ${process.argv[2]}`,
    ext: '.txt',
    contentType: 'text',
  },
  options: {
    config: { rules: rules.map((rule) => ({ id: rule.meta.id, rule })) },
    noPhysicFilePath: true,
  },
})
process.stdout.write(JSON.stringify(result.messages.map((message) => message.ruleId)))
