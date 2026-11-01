import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SELF_TEST_FILE = 'test/fixtures/incidents/not-submitted.md'
const args = process.argv.slice(2)
const selfTest = args.includes('--self-test')
const target = selfTest ? SELF_TEST_FILE : args.find((a) => !a.startsWith('--'))

if (!target || !existsSync(target)) {
  console.error('usage: pnpm repro:incident <report-file> | --self-test')
  process.exit(64)
}

const dir = mkdtempSync(join(tmpdir(), 'ostia-repro-'))
const resultFile = join(dir, 'result.json')
const run = spawnSync('bash', ['scripts/e2e.sh', 'e2e/repro/incident.repro.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OSTIA_E2E_BENCH: 'repro',
    OSTIA_REPRO_INCIDENT: resolve(target),
    OSTIA_REPRO_RESULT: resultFile,
  },
})

let result = null
if (existsSync(resultFile)) result = JSON.parse(readFileSync(resultFile, 'utf8'))
rmSync(dir, { recursive: true, force: true })

if (!result) {
  console.error('repro: the harness stopped before it gave a verdict (exit', run.status, ')')
  process.exit(3)
}
console.log(`\nrepro: ${result.verdict}`)
if (result.reason) console.log(`repro: ${result.reason}`)
if (result.expected)
  console.log(`repro: expected boundary ${result.expected}; saw [${result.observed.join(', ')}]`)
console.log(`repro: ${result.note}`)

const expected = selfTest ? 'reproduced' : null
if (expected && result.verdict !== expected) process.exit(1)
process.exit(result.verdict === 'reproduced' ? 0 : result.verdict === 'unsupported' ? 2 : 1)
