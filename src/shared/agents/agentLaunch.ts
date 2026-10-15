import { envName } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import type { ResumableAgent } from './agentResume'

type Arity = 'none' | 'one' | 'optional' | 'many'

export const AGENT_ARGS_ENV: Record<ResumableAgent, string> = {
  claude: 'CLAUDE_ARGS',
  codex: 'CODEX_ARGS',
}

export const AGENT_ARGS_SEPARATOR = '\u001f'

const MAX_ARGS = 64
const MAX_ARG_LENGTH = 2048
const MAX_ARGS_LENGTH = 8192
const MAX_ENV = 32
const MAX_ENV_VALUE = 1024
const MAX_COMMAND_LINE = 16384

const CLAUDE_FLAGS: Record<string, Arity> = {
  '--agent': 'one',
  '--append-system-prompt': 'one',
  '--autocompact': 'one',
  '--ax-screen-reader': 'none',
  '--bare': 'none',
  '--betas': 'many',
  '--brief': 'none',
  '--debug': 'optional',
  '--disable-slash-commands': 'none',
  '--disallowed-tools': 'many',
  '--disallowedTools': 'many',
  '--effort': 'one',
  '--exclude-dynamic-system-prompt-sections': 'none',
  '--fallback-model': 'one',
  '--ide': 'none',
  '--model': 'one',
  '--name': 'one',
  '--no-chrome': 'none',
  '--permission-mode': 'one',
  '--remote-control': 'optional',
  '--remote-control-session-name-prefix': 'one',
  '--restricted': 'none',
  '--safe-mode': 'none',
  '--strict-mcp-config': 'none',
  '--system-prompt': 'one',
  '--system-prompt-snapshot': 'one',
  '--tools': 'many',
  '--verbose': 'none',
}

const CODEX_FLAGS: Record<string, Arity> = {
  '-a': 'one',
  '--ask-for-approval': 'one',
  '-c': 'one',
  '--config': 'one',
  '--local-provider': 'one',
  '-m': 'one',
  '--model': 'one',
  '--no-alt-screen': 'none',
  '--oss': 'none',
  '-s': 'one',
  '--sandbox': 'one',
  '--search': 'none',
  '--strict-config': 'none',
}

const CLAUDE_PERMISSION_MODES = new Set(['acceptEdits', 'default', 'dontAsk', 'manual', 'plan'])
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write'])
const CODEX_APPROVALS = new Set(['untrusted', 'on-failure', 'on-request'])
const CODEX_CONFIG_KEYS = new Set([
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'service_tier',
])

function isModelConfig(value: string): boolean {
  const eq = value.indexOf('=')
  return eq > 0 && CODEX_CONFIG_KEYS.has(value.slice(0, eq).trim())
}

const ALLOWED_VALUES: Record<ResumableAgent, Record<string, (value: string) => boolean>> = {
  claude: { '--permission-mode': (value) => CLAUDE_PERMISSION_MODES.has(value) },
  codex: {
    '-a': (value) => CODEX_APPROVALS.has(value),
    '--ask-for-approval': (value) => CODEX_APPROVALS.has(value),
    '-c': isModelConfig,
    '--config': isModelConfig,
    '-s': (value) => CODEX_SANDBOXES.has(value),
    '--sandbox': (value) => CODEX_SANDBOXES.has(value),
  },
}

const ALIASES: Record<ResumableAgent, Record<string, string>> = {
  claude: { '-d': '--debug', '-n': '--name' },
  codex: {},
}

const AGENT_FLAGS: Record<ResumableAgent, Record<string, Arity>> = {
  claude: CLAUDE_FLAGS,
  codex: CODEX_FLAGS,
}

const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT|(^|[_.])(PIN|PW)($|[_.])/i

const CODE_LOADING_ENV =
  /^(LD_|DYLD_|XDG_|GIT_CONFIG_|CLAUDE_|CODEX_)|^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PATH|HOME|PROMPT_COMMAND|ZDOTDIR|SHELLOPTS|BASHOPTS|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|JAVA_TOOL_OPTIONS|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG|EDITOR|VISUAL|PAGER)$/

const SECRET_TEXT = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[opsur]_[A-Za-z0-9]{20,}/,
  /github_pat_/,
  /glpat-/,
  /xox[abposr]-/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /eyJ[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN /,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/,
  /api[_-]?key|token|secret|passw|credential|authorization|bearer/i,
  /[A-Za-z0-9_+=-]{40,}/,
]

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export function looksSecret(text: string): boolean {
  return SECRET_TEXT.some((pattern) => pattern.test(text))
}

function isSafeValue(value: string, max: number): boolean {
  return value.length <= max && !hasControlCharacter(value) && !looksSecret(value)
}

function splitFlag(agent: ResumableAgent, arg: string): [string, string | undefined] {
  const flags = AGENT_FLAGS[agent]
  const aliases = ALIASES[agent]
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined]
  }
  const short = arg.slice(0, 2)
  const name = Object.hasOwn(aliases, short) ? aliases[short] : short
  if (arg.length > 2 && Object.hasOwn(flags, name)) {
    const rest = arg.slice(2)
    return [name, rest.startsWith('=') ? rest.slice(1) : rest]
  }
  return [arg.length === 2 ? name : arg, undefined]
}

export function resumeFlags(agent: ResumableAgent, argv: readonly string[]): string[] {
  const flags = AGENT_FLAGS[agent]
  const out: string[] = []
  let total = 0
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    i++
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') continue
    const [name, inline] = splitFlag(agent, arg)
    const arity = Object.hasOwn(flags, name) ? flags[name] : undefined
    const values: string[] = []
    if (arity === 'none') {
      if (inline !== undefined) continue
    } else if (arity === 'one') {
      if (inline !== undefined) values.push(inline)
      else if (i < argv.length) values.push(argv[i++])
      else continue
    } else if (arity === 'optional') {
      if (inline !== undefined) values.push(inline)
      else if (i < argv.length && !argv[i].startsWith('-')) continue
    } else if (arity === 'many') {
      if (inline === undefined) continue
      values.push(inline)
    } else {
      continue
    }
    if (values.some((value) => !isSafeValue(value, MAX_ARG_LENGTH))) continue
    const allowed = ALLOWED_VALUES[agent][name]
    if (allowed && !values.every(allowed)) continue
    const group =
      arity === 'one' ? [name, ...values] : [values.length ? `${name}=${values[0]}` : name]
    const size = group.reduce((sum, part) => sum + part.length, 0)
    if (out.length + group.length > MAX_ARGS || total + size > MAX_ARGS_LENGTH) break
    out.push(...group)
    total += size
  }
  return out
}

export function capturedArgs(
  agent: ResumableAgent,
  env: Record<string, string | undefined>,
): string[] | null {
  const raw = env[envName(AGENT_ARGS_ENV[agent])]
  if (raw === undefined) return null
  if (raw === '') return []
  return resumeFlags(agent, raw.split(AGENT_ARGS_SEPARATOR))
}

export function safeEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ENV) break
    if (!ENV_NAME.test(name) || SECRET_NAME.test(name) || CODE_LOADING_ENV.test(name)) continue
    if (name.startsWith(envName(''))) continue
    if (typeof value !== 'string' || !isSafeValue(value, MAX_ENV_VALUE)) continue
    out[name] = value
  }
  return out
}

const OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')', '\n'])
const UNQUOTED_SAFE = /^[A-Za-z0-9_./:,@%+=#-]$/

interface Word {
  text: string
  plain: boolean
  safe: boolean
}

function readWord(line: string, start: number): { word: Word; end: number } | null {
  let i = start
  let text = ''
  let plain = true
  let safe = true
  while (i < line.length) {
    const ch = line[i]
    if (ch === ' ' || ch === '\t' || OPERATORS.has(ch)) break
    if (ch === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) return null
      text += line.slice(i + 1, close)
      plain = false
      i = close + 1
    } else if (ch === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\') j++
        j++
      }
      if (j >= line.length) return null
      const inner = line.slice(i + 1, j)
      if (/[$`\\]/.test(inner)) safe = false
      text += inner
      plain = false
      i = j + 1
    } else if (ch === '\\') {
      if (i + 1 >= line.length) return null
      text += line[i + 1]
      plain = false
      i += 2
    } else {
      if (!UNQUOTED_SAFE.test(ch)) safe = false
      text += ch
      i++
    }
  }
  return { word: { text, plain, safe }, end: i }
}

export function commandLineEnv(agent: ResumableAgent, line: string): Record<string, string> | null {
  if (line.length > MAX_COMMAND_LINE) return null
  const assigned: Record<string, string> = {}
  let i = 0
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++
    if (i >= line.length || OPERATORS.has(line[i])) return null
    const start = i
    const read = readWord(line, i)
    if (!read) return null
    i = read.end
    const { word } = read
    if (ASSIGNMENT.test(line.slice(start, i))) {
      const eq = word.text.indexOf('=')
      if (word.safe) assigned[word.text.slice(0, eq)] = word.text.slice(eq + 1)
      continue
    }
    if (!word.plain || word.text !== agent) return null
    return safeEnv(assigned)
  }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:,@%+-][A-Za-z0-9_./:,@%+=-]*$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`
}
