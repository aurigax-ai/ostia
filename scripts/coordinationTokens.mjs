import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CHARS_PER_TOKEN = 3.5
export const REPEAT_WINDOW_MS = 10 * 60 * 1000
export const BUS_BLOCK = /<ostia-bus-messages>[\s\S]*?<\/ostia-bus-messages>/g
export const COORDINATION_TURN = /<ostia-bus-messages>|ostia bus:/i
export const DEFAULT_WATCHERS = ['prwatch', 'watcher']

const OSTIA_CALL = /(?:^|[\s;&|(])ostia\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/
const PANE_ARG = /ostia\s+pane\s+read\s+(?:--\S+\s+\S+\s+)*([0-9a-f-]{8,})/
const MERGE_CALL = /\bgh\s+pr\s+merge\b/

export function estimateTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN)
}

export function classifyCommand(command, watchers = DEFAULT_WATCHERS) {
  if (typeof command !== 'string') return null
  const match = OSTIA_CALL.exec(command)
  if (match) return match[2] ? `${match[1]}.${match[2]}` : match[1]
  if (watchers.some((word) => command.includes(word))) return 'watcher'
  return null
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
  let merged = 0
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

  const scanHook = (text) => {
    for (const block of text.match(BUS_BLOCK) ?? []) {
      hooks.busBlocks += 1
      hooks.busChars += block.length
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
      pending.set(event.id, { key, command: event.command, at: event.at })
    } else if (event.kind === 'result') {
      scanHook(event.text)
      const call = pending.get(event.id)
      if (!call) continue
      pending.delete(event.id)
      addTo(call.key, 'resultChars', event.text.length, call.at)
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
      scanHook(event.text)
    } else if (event.kind === 'turn') {
      scanHook(event.text)
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

export function collect({ day, claudeDir, codexDir }) {
  const events = []
  const sources = [
    ['claude', claudeDir],
    ['codex', codexDir],
  ]
  for (const [agent, dir] of sources) {
    for (const file of listJsonl(dir)) {
      const parsed = parseTranscript(readFileSync(file, 'utf8'), agent)
      events.push(
        ...parsed.filter((event) => Number.isFinite(event.at) && localDay(event.at) === day),
      )
    }
  }
  return events
}

function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  const day = flag('--day') ?? localDay(Date.now())
  const result = analyze(
    collect({
      day,
      claudeDir: flag('--claude') ?? join(homedir(), '.claude', 'projects'),
      codexDir: flag('--codex') ?? join(homedir(), '.codex', 'sessions'),
    }),
    { watchers: flag('--watcher')?.split(',') },
  )
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : renderReport(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
