import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../bench-results/flows')
const latest = join(root, 'latest')
const baseline = join(root, 'baseline')

function read(dir) {
  if (!existsSync(dir)) return new Map()
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
      .map((entry) => [entry.flow, entry]),
  )
}

function cell(value, width) {
  return String(value ?? '-').padStart(width)
}

if (process.argv.includes('--save')) {
  rmSync(baseline, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  cpSync(latest, baseline, { recursive: true })
  console.log(`baseline saved from ${latest}`)
  process.exit(0)
}

const now = read(latest)
const before = read(baseline)
if (now.size === 0) {
  console.log('flows: no results in bench-results/flows/latest; run pnpm bench:flows')
  process.exit(0)
}

console.log(
  `${'flow'.padEnd(28)}${cell('runs', 5)}${cell('p50', 8)}${cell('p95', 8)}${cell('budget50', 10)}${cell('budget95', 10)}${cell('base p50', 10)}${cell('base p95', 10)}  status`,
)
for (const [flow, entry] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
  const base = before.get(flow)
  const over =
    entry.budgetP50 !== null && (entry.p50 > entry.budgetP50 || entry.p95 > entry.budgetP95)
  const drift = base && base.p50 > 0 ? Math.round((entry.p50 / base.p50 - 1) * 100) : null
  const status = `${over ? 'OVER' : 'ok'}${drift === null ? '' : ` (${drift >= 0 ? '+' : ''}${drift}% vs baseline)`}`
  console.log(
    `${flow.padEnd(28)}${cell(entry.runs, 5)}${cell(entry.p50, 8)}${cell(entry.p95, 8)}${cell(entry.budgetP50, 10)}${cell(entry.budgetP95, 10)}${cell(base?.p50, 10)}${cell(base?.p95, 10)}  ${status}`,
  )
}
const load = Math.max(...[...now.values()].map((entry) => entry.load1))
console.log(
  `\nmax 1-minute load average during the run: ${load.toFixed(1)}; numbers above load 4 are inflated`,
)
