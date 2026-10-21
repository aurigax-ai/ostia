import { type EvalCase, type EvalRun, type EvalVerdict, MIN_EVAL_CASES } from './evalCase'
import { passes } from './evalCheck'
import type { Complete } from './extract'
import { RULES_HEADER, ruleLine } from './inject'
import type { Rule } from './rule'
import { bootstrapDifference, type Pair } from './stats'

export const PAIRS_PER_CASE = 5

export const EVAL_SYSTEM =
  'You are a coding assistant. Do the task you are given. Reply with the complete answer and nothing else.'

export function evalSystem(rule: Rule | null): string {
  return rule ? `${EVAL_SYSTEM}\n\n${RULES_HEADER}\n${ruleLine(rule)}` : EVAL_SYSTEM
}

export function evalInput(c: Pick<EvalCase, 'prompt' | 'files'>): string {
  const files = c.files.map((f) => `=== ${f.path}\n${f.content}`).join('\n')
  return files ? `Files:\n${files}\n\nTask: ${c.prompt}` : `Task: ${c.prompt}`
}

export interface EvalRunDeps {
  complete: Complete
  random: () => number
  now: () => number
  cancelled: () => boolean
  progress: (done: number, total: number) => void
}

export type EvalOutcome = { ok: true; run: Omit<EvalRun, 'id'> } | { ok: false; error: string }

function verdictOf(low: number, high: number): EvalVerdict {
  if (low > 0) return 'helps'
  return high < 0 ? 'hurts' : 'no-clear-effect'
}

export async function runEval(
  rule: Rule,
  cases: readonly EvalCase[],
  deps: EvalRunDeps,
): Promise<EvalOutcome> {
  if (cases.length < MIN_EVAL_CASES) return { ok: false, error: 'few-cases' }
  const started = deps.now()
  const total = cases.length * PAIRS_PER_CASE * 2
  const byCase: Pair[][] = []
  let done = 0
  const ask = async (c: EvalCase, arm: Rule | null) => {
    if (deps.cancelled()) return { ok: false as const, error: 'cancelled' }
    const answer = await deps.complete(evalSystem(arm), evalInput(c)).catch(() => ({
      ok: false as const,
      error: 'failed',
    }))
    done += 1
    deps.progress(done, total)
    return answer
  }
  for (const c of cases) {
    const pairs: Pair[] = []
    byCase.push(pairs)
    for (let i = 0; i < PAIRS_PER_CASE; i++) {
      const given = await ask(c, rule)
      if (!given.ok) return { ok: false, error: given.error }
      const left = await ask(c, null)
      if (!left.ok) return { ok: false, error: left.error }
      pairs.push({ withRule: passes(c.check, given.text), without: passes(c.check, left.text) })
    }
  }
  const all = byCase.flat()
  const { low, high } = bootstrapDifference(byCase, deps.random)
  return {
    ok: true,
    run: {
      rule: rule.id,
      at: deps.now(),
      pairs: all.length,
      withPass: all.filter((p) => p.withRule).length,
      withoutPass: all.filter((p) => p.without).length,
      low,
      high,
      seconds: Math.round((deps.now() - started) / 1000),
      calls: total,
      verdict: verdictOf(low, high),
    },
  }
}
