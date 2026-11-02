import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id } = JSON.parse(line)
  process.stdout.write(`${JSON.stringify({ id, error: 'rule exploded' })}\n`)
})
