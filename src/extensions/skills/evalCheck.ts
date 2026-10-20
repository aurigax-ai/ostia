import { runInNewContext } from 'node:vm'
import type { EvalCheck } from './evalCase'

const CHECK_TIMEOUT_MS = 200
const OUTPUT_MAX = 20_000

function found(pattern: string, output: string): boolean | null {
  try {
    return (
      runInNewContext(
        'new RegExp(pattern, "m").test(output)',
        { pattern, output: output.slice(0, OUTPUT_MAX) },
        { timeout: CHECK_TIMEOUT_MS },
      ) === true
    )
  } catch {
    return null
  }
}

export function passes(check: EvalCheck, output: string): boolean {
  const hit = found(check.value, output)
  if (hit === null) return false
  return check.kind === 'matches' ? hit : !hit
}
