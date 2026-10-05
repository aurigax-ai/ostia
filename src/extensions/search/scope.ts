import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  type ExtensionCaller,
  type ExtensionResult,
  PRODUCT_NAME,
  expandHome,
  failure,
  namedArgs,
} from '../sdk'
import { MATCH_LIMIT, type TextQuery, type TextResults } from './rg'

export const QUERY_MAX = 1000
const GLOBS_MAX = 32

const RG_MISSING_HINT = `Install it with \`${PRODUCT_NAME} system install ripgrep\`.`

export function rgFailure(res: { error: string; message: string }): ExtensionResult {
  if (res.error === 'rg-missing') return failure('rg-missing', `${res.message}. ${RG_MISSING_HINT}`)
  return failure(res.error, res.message || undefined)
}

function directory(path: string | undefined): string | null {
  if (!path) return null
  const expanded = expandHome(path)
  if (!isAbsolute(expanded)) return null
  try {
    return statSync(expanded).isDirectory() ? expanded : null
  } catch {
    return null
  }
}

export function agentRoot(caller: ExtensionCaller): string | ExtensionResult {
  if (caller.sandboxed) {
    return failure('sandboxed', 'search runs outside the sandbox; run rg inside it instead')
  }
  if (caller.remote) return failure('remote-folder', 'search reads only local folders')
  const root = directory(caller.cwd ?? caller.workDir)
  return root ?? failure('no-folder', 'no local working directory is known for this caller')
}

export function panelRoot(caller: ExtensionCaller): string | null {
  return directory(caller.workDir)
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, max)
    .map((v) => v.trim())
}

export function panelQuery(args: unknown): TextQuery | null {
  const a = namedArgs(args)
  if (typeof a.text !== 'string' || !a.text || a.text.length > QUERY_MAX) return null
  return {
    text: a.text,
    regex: a.regex === true,
    caseSensitive: a.caseSensitive === true,
    wholeWord: a.wholeWord === true,
    include: strings(a.include, GLOBS_MAX),
    exclude: strings(a.exclude, GLOBS_MAX),
  }
}

export function insideRoot(root: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path || isAbsolute(path)) return null
  const full = resolve(root, path)
  const rel = relative(root, full)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null
}

export function formatMatches(results: TextResults): string {
  const lines: string[] = []
  for (const file of results.files) {
    for (const m of file.matches) lines.push(`${file.path}:${m.line}:${m.column}: ${m.text}`)
  }
  const count = `${results.matches} ${results.matches === 1 ? 'match' : 'matches'} in ${results.files.length} ${results.files.length === 1 ? 'file' : 'files'}`
  lines.push(results.matches === 0 ? 'No matches' : count)
  if (results.truncated) {
    lines.push(`Stopped at ${MATCH_LIMIT} matches or the time limit; narrow it with --glob`)
  }
  return lines.join('\n')
}
