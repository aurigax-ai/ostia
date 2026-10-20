import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { type CaseInput, type EvalCase, type EvalRun, parseCaseInput } from './evalCase'

const EVALS_FILE = 'evals.json'
const RUNS_MAX = 50

interface EvalsFile {
  next: number
  cases: EvalCase[]
  runs: EvalRun[]
}

function parseEvals(text: string): EvalsFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const f = raw as Partial<EvalsFile> | null
  if (typeof f?.next !== 'number' || !Array.isArray(f.cases) || !Array.isArray(f.runs)) return null
  const cases = f.cases.filter(
    (c): c is EvalCase =>
      typeof c?.id === 'string' &&
      typeof c.rule === 'string' &&
      (c.origin === 'human' || c.origin === 'model') &&
      typeof c.accepted === 'boolean' &&
      parseCaseInput(c) !== null,
  )
  const runs = f.runs.filter(
    (r): r is EvalRun =>
      typeof r?.id === 'string' && typeof r.rule === 'string' && typeof r.at === 'number',
  )
  return { next: f.next, cases, runs }
}

export class EvalStore {
  private readonly file: string | null
  private next = 1
  private cases: EvalCase[] = []
  private runs: EvalRun[] = []

  constructor(dir: string | null) {
    this.file = dir ? join(dir, EVALS_FILE) : null
    if (this.file && existsSync(this.file)) {
      const parsed = parseEvals(readFileSync(this.file, 'utf8'))
      if (parsed) {
        this.next = parsed.next
        this.cases = parsed.cases
        this.runs = parsed.runs
      } else {
        renameSync(this.file, `${this.file}.corrupt`)
      }
    }
  }

  listCases(): EvalCase[] {
    return this.cases.map((c) => ({
      ...c,
      files: c.files.map((f) => ({ ...f })),
      check: { ...c.check },
    }))
  }

  listRuns(): EvalRun[] {
    return this.runs.map((r) => ({ ...r }))
  }

  addCase(rule: string, input: CaseInput, origin: EvalCase['origin']): EvalCase {
    const made: EvalCase = {
      id: `c${this.next}`,
      rule,
      ...input,
      origin,
      accepted: origin === 'human',
    }
    this.next += 1
    this.cases.push(made)
    this.save()
    return made
  }

  accept(id: string): boolean {
    const found = this.cases.find((c) => c.id === id)
    if (!found) return false
    found.accepted = true
    this.save()
    return true
  }

  removeCase(id: string): boolean {
    const before = this.cases.length
    this.cases = this.cases.filter((c) => c.id !== id)
    if (this.cases.length === before) return false
    this.save()
    return true
  }

  removeRule(rule: string): void {
    this.cases = this.cases.filter((c) => c.rule !== rule)
    this.runs = this.runs.filter((r) => r.rule !== rule)
    this.save()
  }

  addRun(run: Omit<EvalRun, 'id'>): EvalRun {
    const made: EvalRun = { ...run, id: `e${this.next}` }
    this.next += 1
    this.runs = [...this.runs, made].slice(-RUNS_MAX)
    this.save()
    return made
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(
      this.file,
      JSON.stringify({ next: this.next, cases: this.cases, runs: this.runs }, null, 2),
      { mode: 0o600, dirMode: 0o700 },
    )
    chmodSync(this.file, 0o600)
  }
}
