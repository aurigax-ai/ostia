import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id } = JSON.parse(line)
  process.stdout.write(`${JSON.stringify({ id: id + 1000, messages: [] })}\n`)
})
