import { envName } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { hasControlCharacter } from '../common/hiddenText'
import type { ResumableAgent } from './agentResume'

type Arity = 'none' | 'one' | 'optional' | 'many'

export const AGENT_ARGS_ENV: Record<ResumableAgent, string> = {
  claude: 'CLAUDE_ARGS',
  codex: 'CODEX_ARGS',
  agy: 'AGY_ARGS',
}

export const AGENT_ARGS_SEPARATOR = '\u001f'

const MAX_ARGS = 64
const MAX_ARG_LENGTH = 2048
const MAX_ARGS_LENGTH = 8192
const MAX_ENV = 32
const MAX_ENV_VALUE = 1024
const MAX_COMMAND_LINE = 16384

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

const TYPED_CLAUDE_FLAGS: Record<string, Arity> = {
  ...CLAUDE_FLAGS,
  '--add-dir': 'many',
  '--agent': 'one',
  '--agents': 'one',
  '--allow-dangerously-skip-permissions': 'none',
  '--allowed-tools': 'many',
  '--allowedTools': 'many',
  '--append-system-prompt-file': 'one',
  '--chrome': 'none',
  '--dangerously-skip-permissions': 'none',
  '--debug-file': 'one',
  '--mcp-config': 'many',
  '--plugin-dir': 'one',
  '--plugin-url': 'one',
  '--setting-sources': 'one',
  '--settings': 'one',
  '--system-prompt-file': 'one',
}

const TYPED_CODEX_FLAGS: Record<string, Arity> = {
  ...CODEX_FLAGS,
  '--add-dir': 'one',
  '--approve-for-me': 'none',
  '--dangerously-bypass-approvals-and-sandbox': 'none',
  '--dangerously-bypass-hook-trust': 'none',
  '--disable': 'one',
  '--enable': 'one',
  '-p': 'one',
  '--profile': 'one',
  '--remote': 'one',
  '--remote-auth-token-env': 'one',
  '--yolo': 'none',
}

const AGY_FLAGS: Record<string, Arity> = {
  '--effort': 'one',
  '--model': 'one',
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
  agy: {},
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
  agy: {},
}

const AGENT_FLAGS: Record<ResumableAgent, Record<string, Arity>> = {
  claude: CLAUDE_FLAGS,
  codex: CODEX_FLAGS,
  agy: AGY_FLAGS,
}

const TYPED_FLAGS: Record<ResumableAgent, Record<string, Arity>> = {
  claude: TYPED_CLAUDE_FLAGS,
  codex: TYPED_CODEX_FLAGS,
  agy: AGY_FLAGS,
}

const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT|(^|[_.])(PIN|PW)($|[_.])/i

const NOT_SECRET_ENV = new Set(['CLAUDE_SKIP_SESSION_LOG'])

const CODE_LOADING_ENV =
  /^(LD_|DYLD_|XDG_|GIT_|NPM_CONFIG_|CLAUDE_CODE_SHELL)|_BASE_URL$|^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|PATH|HOME|SHELL|PROMPT_COMMAND|ZDOTDIR|SHELLOPTS|BASHOPTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|PERLLIB|PERL5DB|RUBYOPT|RUBYLIB|LUA_PATH|LUA_CPATH|CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|SSH_ASKPASS|EDITOR|VISUAL|PAGER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i

const CONFIG_FLAGS: Record<ResumableAgent, ReadonlySet<string>> = {
  claude: new Set(['--settings', '--agents', '--mcp-config']),
  codex: new Set(['-c', '--config']),
  agy: new Set(),
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const PATH_ENV = new Set(['CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/

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

export function leadsWithFlag(text: string): boolean {
  return /^[-+]/.test(text.trimStart())
}

export function looksSecret(text: string): boolean {
  return SECRET_TEXT.some((pattern) => pattern.test(text))
}

function isSafeValue(value: string, max: number): boolean {
  return value.length <= max && !hasControlCharacter(value) && !looksSecret(value)
}

function isSafeConfig(agent: ResumableAgent, value: string): boolean {
  if (agent === 'claude') return !value.trimStart().startsWith('{')
  const eq = value.indexOf('=')
  const key = (eq < 0 ? value : value.slice(0, eq)).trim()
  return !/(^|\.)env(\.|$)/i.test(key) && !SECRET_NAME.test(key)
}

function splitFlag(
  agent: ResumableAgent,
  flags: Record<string, Arity>,
  arg: string,
): [string, string | undefined] {
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

function isCarried(agent: ResumableAgent, name: string, values: readonly string[]): boolean {
  if (!Object.hasOwn(AGENT_FLAGS[agent], name)) return false
  const allowed = ALLOWED_VALUES[agent][name]
  return !allowed || values.every(allowed)
}

function readFlags(
  agent: ResumableAgent,
  flags: Record<string, Arity>,
  argv: readonly string[],
  keep: (name: string, values: string[]) => boolean,
  spacedLists = false,
): string[] {
  const out: string[] = []
  let total = 0
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    i++
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') continue
    const [name, inline] = splitFlag(agent, flags, arg)
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
      if (inline !== undefined) values.push(inline)
      else if (spacedLists && i < argv.length && !argv[i].startsWith('-')) values.push(argv[i++])
      else continue
    } else {
      continue
    }
    if (values.some((value) => value.startsWith('-') || !isSafeValue(value, MAX_ARG_LENGTH))) {
      continue
    }
    if (!keep(name, values)) continue
    const group =
      arity === 'one' ? [name, ...values] : [values.length ? `${name}=${values[0]}` : name]
    const size = group.reduce((sum, part) => sum + part.length, 0)
    if (out.length + group.length > MAX_ARGS || total + size > MAX_ARGS_LENGTH) break
    out.push(...group)
    total += size
  }
  return out
}

export function resumeFlags(agent: ResumableAgent, argv: readonly string[]): string[] {
  return readFlags(agent, AGENT_FLAGS[agent], argv, (name, values) =>
    isCarried(agent, name, values),
  )
}

function typedFlags(agent: ResumableAgent, argv: readonly string[]): string[] {
  return readFlags(
    agent,
    TYPED_FLAGS[agent],
    argv,
    (name, values) =>
      !isCarried(agent, name, values) &&
      (!CONFIG_FLAGS[agent].has(name) || values.every((value) => isSafeConfig(agent, value))),
    true,
  )
}

export const CODEX_HOOK_ARGS_JSON = 'hook-args.json'

export function capturedArgs(
  agent: ResumableAgent,
  env: Record<string, string | undefined>,
): string[] | null {
  const raw = env[envName(AGENT_ARGS_ENV[agent])]
  if (raw === undefined) return null
  if (raw === '') return []
  return resumeFlags(agent, raw.split(AGENT_ARGS_SEPARATOR))
}

function safeEnv(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_ENV) break
    if (!ENV_NAME.test(name) || CODE_LOADING_ENV.test(name)) continue
    if (SECRET_NAME.test(name) && !NOT_SECRET_ENV.has(name)) continue
    if (name.startsWith(envName(''))) continue
    if (typeof value !== 'string' || !isSafeValue(value, MAX_ENV_VALUE)) continue
    if (PATH_ENV.has(name) && !ABSOLUTE_PATH.test(value)) continue
    out[name] = value
  }
  return out
}

export interface TypedLaunch {
  args?: string[]
  env?: Record<string, string>
}

export function typedLaunchOf(agent: ResumableAgent, raw: unknown): TypedLaunch | undefined {
  if (!isRecord(raw)) return undefined
  const args =
    Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === 'string')
      ? typedFlags(agent, raw.args)
      : []
  const env = safeEnv(raw.env)
  const typed: TypedLaunch = {}
  if (args.length > 0) typed.args = args
  if (Object.keys(env).length > 0) typed.env = env
  return typed.args || typed.env ? typed : undefined
}

const OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')', '\n'])
const UNQUOTED_SAFE = /^[A-Za-z0-9_./:,@%+=#-]$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const UNREADABLE_WORD = '\u0000'

interface Word {
  text: string
  safe: boolean
}

function readWord(line: string, start: number): { word: Word; end: number } | null {
  let i = start
  let text = ''
  let safe = true
  while (i < line.length) {
    const ch = line[i]
    if (ch === ' ' || ch === '\t' || OPERATORS.has(ch)) break
    if (ch === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) return null
      text += line.slice(i + 1, close)
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
      i = j + 1
    } else if (ch === '\\') {
      if (i + 1 >= line.length) return null
      text += line[i + 1]
      i += 2
    } else {
      if (!UNQUOTED_SAFE.test(ch)) safe = false
      text += ch
      i++
    }
  }
  return { word: { text, safe }, end: i }
}

export function typedLaunch(agent: ResumableAgent, line: string): TypedLaunch | undefined {
  if (line.length > MAX_COMMAND_LINE) return undefined
  let assigned = new Map<string, string>()
  let words: string[] | null = null
  let commandStart = true
  let i = 0
  while (i < line.length) {
    if (line[i] === ' ' || line[i] === '\t') {
      i++
      continue
    }
    if (OPERATORS.has(line[i])) {
      if (words) break
      commandStart = true
      assigned = new Map()
      i++
      continue
    }
    const start = i
    const read = readWord(line, i)
    if (!read) return undefined
    i = read.end
    const { word } = read
    const raw = line.slice(start, i)
    if (words) {
      words.push(word.safe ? word.text : UNREADABLE_WORD)
    } else if (commandStart && ASSIGNMENT.test(raw)) {
      const eq = word.text.indexOf('=')
      if (word.safe) assigned.set(word.text.slice(0, eq), word.text.slice(eq + 1))
    } else if (commandStart) {
      commandStart = false
      if (raw === agent || raw === `'${agent}'`) words = []
    }
  }
  if (!words) return undefined
  return typedLaunchOf(agent, { args: words, env: Object.fromEntries(assigned) })
}
