import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id } = JSON.parse(line)
  const names = Object.keys(process.env).sort().join(',')
  process.stdout.write(`${JSON.stringify({ id, error: names })}\n`)
})
