import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CHARS_PER_TOKEN = 3.5
export const REPEAT_WINDOW_MS = 10 * 60 * 1000
export const REREAD_WINDOW_MS = 5 * 60 * 1000
export const BUS_BLOCK = /<ostia-bus-messages>[\s\S]*?<\/ostia-bus-messages>/g
export const COORDINATION_TURN = /<ostia-bus-messages>|ostia bus:/i
export const DEFAULT_WATCHERS = ['prwatch', 'watcher']

const OSTIA_CALL =
  /(?:^|[\s;&|(])(?:ostia|"?\$\{?OSTIA_CLI\}?"?)\s+([a-z][a-z-]*)(?:\.([a-zA-Z][\w.]*)|\s+([a-z][a-z-]*))?/
const PANE_ARG = /ostia\s+pane\s+read\s+(?:--\S+\s+\S+\s+)*([0-9a-f-]{8,})/
const MERGE_CALL = /\bgh\s+pr\s+merge\b/
const VERB_HELP = /\s(?:--help|-h)(?:\s|$)/
const SHELL_LOOP = /\b(?:while|until|for)\b[^;]*;\s*do\b/
const SLEEP = /\bsleep\s+\d/
const PARSER_PIPE = /\bostia\s[^|;&]*\|\s*(?:jq|python3?|node)\b/
const SKILL_BASE = /^Base directory for this skill: \S*ostia\S*\/claude-plugin\/skills\/([\w-]+)/
const ERROR_LINE = /^ostia\b[^:\n]*: |^usage: ostia /

export function estimateTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN)
}

export function classifyCommand(command, watchers = DEFAULT_WATCHERS) {
  if (typeof command !== 'string') return null
  const match = OSTIA_CALL.exec(command)
  if (match) {
    if (match[2]) return `raw:${match[1]}.${match[2]}`
    return match[3] ? `${match[1]}.${match[3]}` : match[1]
  }
  if (watchers.some((word) => command.includes(word))) return 'watcher'
  return null
}

export function errorCode(text) {
  const line = text.split('\n').find((candidate) => ERROR_LINE.test(candidate))
  if (!line) return null
  if (line.startsWith('usage:')) return 'usage'
  const rest = line.slice(line.indexOf(': ') + 2)
  const failed = /^[a-z][a-z -]* failed \(([a-z][a-z-]*):/.exec(rest)
  if (failed) return failed[1]
  const code = /^([a-z][a-z-]*):/.exec(rest)
  if (code) return code[1]
  const words = []
  for (const word of rest.split(/\s+/)) {
    if (!/^[a-z]+$/.test(word) || words.length === 2) break
    words.push(word)
  }
  return words.length > 0 ? words.join('-') : 'other'
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : (part?.text ?? part?.output ?? '')))
    .join('')
}

function parseJson(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function claudeEvents(record) {
  const at = Date.parse(record.timestamp ?? '')
  const content = record.message?.content
  const events = []
  if (record.type === 'assistant' && Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'tool_use' && part.name === 'Bash') {
        events.push({ kind: 'call', id: part.id, at, command: part.input?.command ?? '' })
      }
    }
    const usage = record.message?.usage
    if (usage) {
      events.push({
        kind: 'usage',
        at,
        tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      })
    }
  } else if (record.type === 'user' && record.isMeta) {
    const text = textOf(content)
    const skill = SKILL_BASE.exec(text)
    if (skill) events.push({ kind: 'skill', at, name: skill[1], chars: text.length })
  } else if (record.type === 'user' && Array.isArray(content)) {
    const text = []
    for (const part of content) {
      if (part?.type === 'tool_result') {
        events.push({ kind: 'result', id: part.tool_use_id, at, text: textOf(part.content) })
      } else if (part?.type === 'text') text.push(part.text ?? '')
    }
    if (text.length > 0) events.push({ kind: 'turn', at, text: text.join('') })
  } else if (record.type === 'user' && typeof content === 'string') {
    events.push({ kind: 'turn', at, text: content })
  } else if (record.type === 'attachment') {
    events.push({ kind: 'context', at, text: JSON.stringify(record.attachment ?? '') })
  }
  return events
}

function codexCommand(payload) {
  if (payload.type === 'custom_tool_call') return textOf(payload.input)
  const args = parseJson(payload.arguments ?? '') ?? {}
  const raw = args.cmd ?? args.command
  return Array.isArray(raw) ? raw.join(' ') : (raw ?? '')
}

function codexEvents(record) {
  const at = Date.parse(record.timestamp ?? '')
  const payload = record.payload ?? {}
  if (record.type === 'response_item') {
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      return [{ kind: 'call', id: payload.call_id, at, command: codexCommand(payload) }]
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      return [{ kind: 'result', id: payload.call_id, at, text: textOf(payload.output) }]
    }
    if (payload.type === 'message' && payload.role === 'user') {
      return [{ kind: 'turn', at, text: textOf(payload.content) }]
    }
  }
  if (record.type === 'token_usage_record') {
    return [{ kind: 'usage', at, tokens: payload.usage?.input_tokens ?? 0 }]
  }
  return []
}

export function parseTranscript(text, agent) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const record = parseJson(line)
    if (record) events.push(...(agent === 'codex' ? codexEvents(record) : claudeEvents(record)))
  }
  return events
}

function emptyChannel() {
  return { calls: 0, commandChars: 0, resultChars: 0, tokens: 0 }
}

function hourOf(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`
}

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function analyze(events, options = {}) {
  const watchers = options.watchers ?? DEFAULT_WATCHERS
  const sorted = [...events].sort((a, b) => (a.at || 0) - (b.at || 0))
  const channels = {}
  const perHour = {}
  const pending = new Map()
  const lastRead = new Map()
  const repeats = { count: 0, resultChars: 0 }
  const hooks = { busBlocks: 0, busChars: 0 }
  const turns = { total: 0, coordination: 0, overheadTokens: 0, coordinationOverheadTokens: 0 }
  const behaviour = { loops: 0, sleeps: 0, parsed: 0, verbHelp: 0, raw: 0 }
  const rereads = { count: 0, resultChars: 0 }
  const errors = {}
  const skills = {}
  let merged = 0
  const lastBusBlock = new Map()
  let inCoordinationTurn = false

  const addTo = (key, field, amount, at) => {
    channels[key] ??= emptyChannel()
    channels[key][field] += amount
    if (field === 'commandChars' || field === 'resultChars') {
      const tokens = estimateTokens(amount)
      channels[key].tokens += tokens
      if (Number.isFinite(at)) {
        const hour = hourOf(at)
        perHour[hour] ??= { calls: 0, tokens: 0 }
        perHour[hour].tokens += tokens
      }
    }
  }

  const scanHook = (event) => {
    for (const block of event.text.match(BUS_BLOCK) ?? []) {
      hooks.busBlocks += 1
      hooks.busChars += block.length
      lastBusBlock.set(event.session, event.at)
    }
  }

  for (const event of sorted) {
    if (event.kind === 'call') {
      if (MERGE_CALL.test(event.command)) merged += 1
      const key = classifyCommand(event.command, watchers)
      if (!key) continue
      channels[key] ??= emptyChannel()
      channels[key].calls += 1
      if (Number.isFinite(event.at)) {
        const hour = hourOf(event.at)
        perHour[hour] ??= { calls: 0, tokens: 0 }
        perHour[hour].calls += 1
      }
      addTo(key, 'commandChars', event.command.length, event.at)
      if (SHELL_LOOP.test(event.command)) behaviour.loops += 1
      if (SLEEP.test(event.command)) behaviour.sleeps += 1
      if (PARSER_PIPE.test(event.command)) behaviour.parsed += 1
      if (key.includes('.') && VERB_HELP.test(event.command)) behaviour.verbHelp += 1
      if (key.startsWith('raw:')) behaviour.raw += 1
      pending.set(event.id, { key, command: event.command, at: event.at, session: event.session })
    } else if (event.kind === 'result') {
      scanHook(event)
      const call = pending.get(event.id)
      if (!call) continue
      pending.delete(event.id)
      addTo(call.key, 'resultChars', event.text.length, call.at)
      const code = errorCode(event.text)
      if (code) errors[code] = (errors[code] ?? 0) + 1
      const blockAt = lastBusBlock.get(call.session) ?? Number.NEGATIVE_INFINITY
      if (call.key === 'bus.inbox' && call.at - blockAt <= REREAD_WINDOW_MS) {
        rereads.count += 1
        rereads.resultChars += event.text.length
      }
      if (call.key === 'pane.read') {
        const pane = PANE_ARG.exec(call.command)?.[1] ?? ''
        const hash = hashOf(event.text)
        const before = lastRead.get(pane)
        if (before && before.hash === hash && call.at - before.at <= REPEAT_WINDOW_MS) {
          repeats.count += 1
          repeats.resultChars += event.text.length
        }
        lastRead.set(pane, { hash, at: call.at })
      }
    } else if (event.kind === 'context') {
      scanHook(event)
    } else if (event.kind === 'skill') {
      skills[event.name] ??= { loads: 0, chars: 0 }
      skills[event.name].loads += 1
      skills[event.name].chars += event.chars
    } else if (event.kind === 'turn') {
      scanHook(event)
      turns.total += 1
      inCoordinationTurn = COORDINATION_TURN.test(event.text)
      if (inCoordinationTurn) turns.coordination += 1
    } else if (event.kind === 'usage') {
      turns.overheadTokens += event.tokens
      if (inCoordinationTurn) turns.coordinationOverheadTokens += event.tokens
    }
  }

  const coordinationTokens =
    Object.values(channels).reduce((sum, c) => sum + c.tokens, 0) +
    turns.coordinationOverheadTokens +
    estimateTokens(hooks.busChars)
  const tasks = Math.max(1, merged)
  return {
    channels,
    hooks,
    repeats,
    rereads,
    behaviour,
    errors,
    skills,
    turns,
    perHour,
    tasks: merged,
    coordinationTokens,
    perTask: {
      coordinationTokens: Math.round(coordinationTokens / tasks),
      paneReads: Math.round(((channels['pane.read']?.calls ?? 0) / tasks) * 100) / 100,
      pollingCalls: Math.round(((channels.watcher?.calls ?? 0) / tasks) * 100) / 100,
    },
  }
}

function countList(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return entries.length > 0 ? entries.map(([key, n]) => `${key} ${n}`).join(', ') : 'none'
}

export function renderReport(result) {
  const rows = Object.entries(result.channels)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(
      ([key, c]) =>
        `${key.padEnd(18)} calls ${String(c.calls).padStart(5)}  written ${String(c.commandChars).padStart(8)}  read ${String(c.resultChars).padStart(9)}  ~tokens ${String(c.tokens).padStart(8)}`,
    )
  return [
    ...rows,
    `bus context blocks ${result.hooks.busBlocks}, ${result.hooks.busChars} chars`,
    `repeated pane reads ${result.repeats.count}, ${result.repeats.resultChars} chars`,
    `bus inbox read again after a bus block ${result.rereads.count}, ${result.rereads.resultChars} chars`,
    `calls in shell loops ${result.behaviour.loops}, with sleep ${result.behaviour.sleeps}, piped into a parser ${result.behaviour.parsed}, verb --help ${result.behaviour.verbHelp}, dotted raw ids ${result.behaviour.raw}`,
    `ostia errors ${countList(result.errors)}`,
    `skill loads ${
      Object.entries(result.skills)
        .map(([name, s]) => `${name} ${s.loads}x ${s.chars} chars`)
        .join(', ') || 'none'
    }`,
    `turns ${result.turns.total}, started to coordinate ${result.turns.coordination}, their input+cache-read tokens ${result.turns.coordinationOverheadTokens}`,
    `merged PRs ${result.tasks}; coordination tokens ${result.coordinationTokens}; per task ${result.perTask.coordinationTokens}, pane reads ${result.perTask.paneReads}, polling calls ${result.perTask.pollingCalls}`,
  ].join('\n')
}

function listJsonl(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) listJsonl(path, out)
    else if (name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

function localDay(at) {
  return hourOf(at).slice(0, 10)
}

export async function collect({ day, claudeDir, codexDir }) {
  const events = []
  const sources = [
    ['claude', claudeDir],
    ['codex', codexDir],
  ]
  for (const [agent, dir] of sources) {
    for (const file of listJsonl(dir)) {
      const parsed = []
      const lines = createInterface({
        input: createReadStream(file),
        crlfDelay: Number.POSITIVE_INFINITY,
      })
      for await (const line of lines) parsed.push(...parseTranscript(line, agent))
      for (const event of parsed) {
        if (!Number.isFinite(event.at)) continue
        if (day !== 'all' && localDay(event.at) !== day) continue
        events.push({ ...event, session: file })
      }
    }
  }
  return events
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function runFixtures() {
  execFileSync('pnpm', ['run', 'build:cli'], { cwd: ROOT, stdio: 'ignore' })
  const dir = mkdtempSync(join(tmpdir(), 'ostia-agent-tokens-'))
  const out = join(dir, 'results.json')
  try {
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'agent-tokens'], {
      cwd: ROOT,
      env: { ...process.env, AGENT_TOKENS_OUT: out },
      encoding: 'utf8',
    })
    if (run.status !== 0) throw new Error(`fixture run failed\n${run.stdout}${run.stderr}`)
    return JSON.parse(readFileSync(out, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function benchLines(results, before) {
  const surfaces = [...new Set([...Object.keys(results), ...Object.keys(before ?? {})])].sort()
  return surfaces.map((surface) => {
    const now = results[surface] ?? { chars: 0 }
    const line = { chars: now.chars, tokens: estimateTokens(now.chars) }
    if (now.exit !== undefined) line.exit = now.exit
    if (before) {
      const was = before[surface]?.chars ?? 0
      line.beforeChars = was
      line.deltaTokens = estimateTokens(now.chars) - estimateTokens(was)
    }
    return `BENCH agent-tokens ${surface} ${JSON.stringify(line)}`
  })
}

export function transcriptBenchLine(result) {
  const channels = Object.values(result.channels)
  const errors = Object.values(result.errors).reduce((sum, n) => sum + n, 0)
  return `BENCH agent-tokens transcripts ${JSON.stringify({
    calls: channels.reduce((sum, c) => sum + c.calls, 0),
    tokens: channels.reduce((sum, c) => sum + c.tokens, 0),
    busBlockTokens: estimateTokens(result.hooks.busChars),
    errors,
    rereads: result.rereads.count,
    ...result.behaviour,
  })}`
}

async function transcripts(flag, json) {
  const result = analyze(
    await collect({
      day: flag('--day') ?? localDay(Date.now()),
      claudeDir: flag('--claude') ?? join(homedir(), '.claude', 'projects'),
      codexDir: flag('--codex') ?? join(homedir(), '.codex', 'sessions'),
    }),
    { watchers: flag('--watcher')?.split(',') },
  )
  console.log(
    json
      ? JSON.stringify(result, null, 2)
      : `${renderReport(result)}\n${transcriptBenchLine(result)}`,
  )
}

async function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  if (argv.includes('--transcripts')) return transcripts(flag, argv.includes('--json'))
  const results = runFixtures()
  const save = flag('--save')
  if (save) writeFileSync(save, `${JSON.stringify(results, null, 2)}\n`)
  const against = flag('--against')
  const before = against ? JSON.parse(readFileSync(against, 'utf8')) : undefined
  console.log(benchLines(results, before).join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
