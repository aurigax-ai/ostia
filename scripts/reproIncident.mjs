import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const FIXTURES = 'test/fixtures/incidents'
const args = process.argv.slice(2)
const selfTest = args.includes('--self-test')
const targets = selfTest
  ? readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(FIXTURES, name))
  : args.filter((a) => !a.startsWith('--'))

if (targets.length === 0 || targets.some((file) => !existsSync(file))) {
  console.error('usage: pnpm repro:incident <report-file> | --self-test')
  process.exit(64)
}

function replay(file) {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-repro-'))
  const resultFile = join(dir, 'result.json')
  const run = spawnSync('bash', ['scripts/e2e.sh', 'e2e/repro/incident.repro.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      OSTIA_E2E_BENCH: 'repro',
      OSTIA_REPRO_INCIDENT: resolve(file),
      OSTIA_REPRO_RESULT: resultFile,
    },
  })
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null
  rmSync(dir, { recursive: true, force: true })
  return result ?? { verdict: 'harness-stopped', reason: `exit ${run.status}`, note: '' }
}

let worst = 0
for (const file of targets) {
  const result = replay(file)
  console.log(`\nrepro ${file}: ${result.verdict}`)
  if (result.reason) console.log(`repro: ${result.reason}`)
  if (result.expected) {
    console.log(`repro: expected ${result.expected}; saw [${result.observed.join(', ')}]`)
  }
  if (result.screen) console.log(`repro: caller screen at the end:\n${result.screen}`)
  if (result.note) console.log(`repro: ${result.note}`)
  const code =
    result.verdict === 'reproduced' ? 0 : result.verdict === 'unsupported' && !selfTest ? 2 : 1
  worst = Math.max(worst, code)
}
process.exit(worst)
