import { mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { percentile } from '../echoProbe'
import { BUDGETS } from './budgets'

const RESULTS_DIR = resolve(__dirname, '../../bench-results/flows/latest')

export const RUNS = Number(process.env.OSTIA_FLOW_RUNS ?? 20)
export const WARMUP = Number(process.env.OSTIA_FLOW_WARMUP ?? 2)

function recordFlow(flow: string, samples: number[]): void {
  const budget = BUDGETS[flow]
  const entry = {
    flow,
    runs: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: percentile(samples, 0),
    max: percentile(samples, 1),
    budgetP50: budget?.p50 ?? null,
    budgetP95: budget?.p95 ?? null,
    load1: loadavg()[0],
    at: new Date().toISOString(),
    samples,
  }
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, `${flow}.json`), `${JSON.stringify(entry)}\n`)
  console.log(`FLOW ${flow} p50=${entry.p50} p95=${entry.p95} n=${samples.length}`)
}

export class Samples {
  private readonly by = new Map<string, number[]>()

  add(flow: string, value: number): void {
    const list = this.by.get(flow) ?? []
    list.push(value)
    this.by.set(flow, list)
  }

  flush(): void {
    for (const [flow, values] of this.by) recordFlow(flow, values)
  }
}
