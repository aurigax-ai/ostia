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

const CLAUDE_FLAGS: Record<string, Arity> = {
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

const CLAUDE_PERMISSION_MODES = new Set(['dontAsk', 'manual', 'plan'])
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
    if (values.some((value) => value.startsWith('-') || !isSafeValue(value, MAX_ARG_LENGTH))) {
      continue
    }
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

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:,@%+-][A-Za-z0-9_./:,@%+=-]*$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`
}
