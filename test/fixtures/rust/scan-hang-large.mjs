import { createInterface } from 'node:readline'

const TOKEN = /npm_[A-Za-z0-9]{36}/

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, content } = JSON.parse(line)
  if (content.length > 1000) return
  const found = TOKEN.exec(content)
  const messages = found
    ? [
        {
          ruleId: '@secretlint/secretlint-rule-npm',
          range: [found.index, found.index + found[0].length],
          data: {},
        },
      ]
    : []
  process.stdout.write(`${JSON.stringify({ id, messages })}\n`)
})
