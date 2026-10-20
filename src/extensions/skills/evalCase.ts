export const MIN_EVAL_CASES = 3

const CASE_PROMPT_MAX = 2000
const CASE_FILES_MAX = 5
const CASE_PATH_MAX = 200
const CASE_FILE_MAX = 20_000
export const CASE_PATTERN_MAX = 200
export const CASES_PER_RULE_MAX = 5

interface EvalFile {
  path: string
  content: string
}

export interface EvalCheck {
  kind: 'matches' | 'absent'
  value: string
}

export interface EvalCase {
  id: string
  rule: string
  prompt: string
  files: EvalFile[]
  check: EvalCheck
  origin: 'human' | 'model'
  accepted: boolean
}

export type EvalVerdict = 'helps' | 'no-clear-effect' | 'hurts'

export interface EvalRun {
  id: string
  rule: string
  at: number
  pairs: number
  withPass: number
  withoutPass: number
  low: number
  high: number
  seconds: number
  calls: number
  verdict: EvalVerdict
}

export type CaseInput = Pick<EvalCase, 'prompt' | 'files' | 'check'>

function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.trim().replaceAll('\\', '/')
  if (!path || path.length > CASE_PATH_MAX || path.startsWith('/') || path.includes('\0'))
    return null
  return path.split('/').some((part) => part === '..' || part === '') ? null : path
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'm')
    return true
  } catch {
    return false
  }
}

export function parseCaseInput(raw: unknown): CaseInput | null {
  const r = raw as { prompt?: unknown; files?: unknown; check?: unknown } | null
  if (typeof r?.prompt !== 'string') return null
  const prompt = r.prompt.trim()
  if (!prompt || prompt.length > CASE_PROMPT_MAX) return null
  const filesRaw = r.files === undefined ? [] : r.files
  if (!Array.isArray(filesRaw) || filesRaw.length > CASE_FILES_MAX) return null
  const files: EvalFile[] = []
  for (const f of filesRaw) {
    const path = cleanPath((f as { path?: unknown } | null)?.path)
    const content = (f as { content?: unknown } | null)?.content
    if (!path || typeof content !== 'string' || content.length > CASE_FILE_MAX) return null
    if (files.some((x) => x.path === path)) return null
    files.push({ path, content })
  }
  const check = r.check as { kind?: unknown; value?: unknown } | null
  if (check?.kind !== 'matches' && check?.kind !== 'absent') return null
  const value = typeof check.value === 'string' ? check.value : ''
  if (!value || value.length > CASE_PATTERN_MAX || !compiles(value)) return null
  return { prompt, files, check: { kind: check.kind, value } }
}
