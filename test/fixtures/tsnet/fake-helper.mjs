import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.FAKE_TSNET_ARGV) {
  appendFileSync(process.env.FAKE_TSNET_ARGV, `${JSON.stringify(args)}\n`)
}
if (args.includes('--logout')) process.exit(0)

const lines = JSON.parse(process.env.FAKE_TSNET_LINES ?? '[]')
for (const line of lines) process.stdout.write(`${line}\n`)

if (process.env.FAKE_TSNET_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(7), Number(process.env.FAKE_TSNET_EXIT_AFTER_MS))
}
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
