import {
  INCIDENT_BLOCK_TAG,
  type IncidentBlock,
  type IncidentEvent,
  type IncidentSnapshot,
  incidentBlockSchema,
  triggerWords,
} from '../../shared/agents/incident'
import type { IncidentTake } from './incidentTimeline'

export interface IncidentFacts {
  app: string
  platform: string
  agent: { kind: string; version?: string }
  settings: Record<string, boolean>
  counts: Record<string, number>
  sinceMin: number
  unseen: string[]
}

export interface IncidentWords {
  happened: string
  expected: string
}

const STATE_WORDS: Readonly<Record<string, string>> = {
  working: 'working',
  waiting: 'waiting for you',
  done: 'idle',
  idle: 'idle',
  error: 'failed',
  hibernated: 'hibernated',
  waking: 'starting',
  exited: 'exited',
  shell: 'at a shell',
}

const AT_PROMPT: ReadonlySet<string> = new Set(['waiting', 'done', 'idle', 'shell'])

const UNSEEN_WORDS: Readonly<Record<string, string>> = {
  'agent-internals': "the agent's own screen and reasoning",
  'terminal-text': 'terminal text',
  'model-output': 'model output',
  'prompt-text': 'prompts and messages',
}

const SECOND = 1000

export function incidentBlock(take: IncidentTake, facts: IncidentFacts): IncidentBlock {
  const aliases = new Map<string, string>()
  for (const caller of take.callers) {
    if (caller !== take.paneId && !aliases.has(caller)) aliases.set(caller, `P${aliases.size + 1}`)
  }
  aliases.set(take.paneId, `P${aliases.size + 1}`)
  const first = take.events[0]?.at ?? 0
  const events = take.events.map((event): IncidentEvent => {
    if (event.k !== 'call') return { ...event, at: Math.round(event.at - first) } as IncidentEvent
    const { from, at, ...rest } = event
    const alias = from === undefined ? undefined : aliases.get(from)
    return {
      ...rest,
      at: Math.round(at - first),
      ...(alias ? { from: alias } : {}),
    } as IncidentEvent
  })
  return incidentBlockSchema.parse({
    version: 1,
    app: facts.app,
    platform: facts.platform,
    agent: facts.agent,
    settings: facts.settings,
    pane: aliases.get(take.paneId),
    trigger: take.trigger,
    events,
    unseen: facts.unseen,
    counts: facts.counts,
    sinceMin: facts.sinceMin,
  })
}

const seconds = (ms: number): string => `${(ms / SECOND).toFixed(1)} s`
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)
const spaced = (codeName: string): string => codeName.replaceAll('-', ' ')

function snapshotWords(s: IncidentSnapshot): string {
  const state = STATE_WORDS[s.state] ?? spaced(s.state)
  return [
    state,
    AT_PROMPT.has(s.state) ? 'at prompt' : 'no prompt',
    s.drafting ? 'draft present' : 'draft empty',
    ...(s.mail > 0 ? [`mail ${s.mail} queued`] : []),
  ].join(' · ')
}

function headline(block: IncidentBlock): string {
  const causes: string[] = []
  for (const event of block.events) {
    const cause =
      event.k === 'mail' || event.k === 'wake'
        ? event.code
        : event.k === 'call' && event.phase === 'end'
          ? event.code
          : event.k === 'hook' && !event.ok
            ? (event.code ?? 'hook-failed')
            : undefined
    if (cause && !causes.includes(cause)) causes.push(cause)
  }
  const named = (causes.length > 0 ? causes : [block.trigger]).slice(0, 2).map(triggerWords)
  return named.map((text, i) => (i === 0 ? text : lowerFirst(text))).join(', then ')
}

interface Row {
  at: number
  who: string
  verb: string
  what: string
  details?: string[]
}

function rows(block: IncidentBlock): Row[] {
  const target = block.pane
  const out: Row[] = []
  const pending = new Map<string, { row: Row; index: number }>()
  for (const event of block.events) {
    if (event.k === 'call') {
      const key = `${event.method}|${event.from ?? ''}`
      const who = `${event.from ? `${event.from}→` : ''}${target}`
      if (event.phase === 'start') {
        const row: Row = { at: event.at, who, verb: event.method, what: 'never returned' }
        if (event.before) row.details = [`before: ${snapshotWords(event.before)}`]
        pending.set(key, { row, index: out.length })
        out.push(row)
      } else if (event.phase === 'phase') {
        const open = pending.get(key)
        const part = `${spaced(event.name ?? 'phase')} ${seconds(event.ms ?? 0)}`
        if (open)
          open.row.what = open.row.what === 'never returned' ? part : `${open.row.what}  ${part}`
      } else {
        const open = pending.get(key)
        pending.delete(key)
        const outcome =
          event.phase === 'cancel' ? 'cancelled' : event.code ? spaced(event.code) : 'ok'
        const timing = event.ms === undefined ? '' : ` ${seconds(event.ms)}`
        if (open) {
          const phases = open.row.what === 'never returned' ? '' : `  ${open.row.what}`
          open.row.what = `${outcome}${timing}${phases}`
          if (event.after) {
            open.row.details = [
              ...(open.row.details ?? []),
              `after:  ${snapshotWords(event.after)}`,
            ]
          }
        } else {
          out.push({ at: event.at, who, verb: event.method, what: `${outcome}${timing}` })
        }
      }
    } else if (event.k === 'state') {
      const from = event.from ? `${STATE_WORDS[event.from] ?? spaced(event.from)} → ` : ''
      out.push({
        at: event.at,
        who: target,
        verb: 'state',
        what: `${from}${STATE_WORDS[event.to] ?? spaced(event.to)}`,
      })
    } else if (event.k === 'hook') {
      out.push({
        at: event.at,
        who: target,
        verb: 'hook',
        what: event.ok
          ? spaced(event.code ?? 'received')
          : `failed ${spaced(event.code ?? '')}`.trim(),
      })
    } else if (event.k === 'mail') {
      out.push({
        at: event.at,
        who: target,
        verb: 'mail',
        what: `${spaced(event.code)}${event.age ? ` (${seconds(event.age)} old)` : ''}`,
      })
    } else {
      out.push({
        at: event.at,
        who: target,
        verb: 'wake',
        what: `${spaced(event.code)} ${seconds(event.ms)}`,
      })
    }
  }
  return out
}

function timeline(block: IncidentBlock): string[] {
  const end = block.events.at(-1)?.at ?? 0
  const list = rows(block)
  const stamps = list.map((row) => `-${((end - row.at) / SECOND).toFixed(1)}`)
  const pad = (values: string[]): number => Math.max(0, ...values.map((v) => v.length))
  const timeW = pad(stamps)
  const whoW = pad(list.map((r) => r.who))
  const verbW = pad(list.map((r) => r.verb))
  const lines: string[] = []
  list.forEach((row, i) => {
    lines.push(
      `${(stamps[i] ?? '').padStart(timeW)}  ${row.who.padEnd(whoW)}  ${row.verb.padEnd(verbW)}  ${row.what}`,
    )
    for (const detail of row.details ?? []) {
      lines.push(`${' '.repeat(timeW + whoW + verbW + 6)}${detail}`)
    }
  })
  return lines
}

function targetLine(block: IncidentBlock): string {
  const end = block.events.at(-1)?.at ?? 0
  let last: IncidentSnapshot | undefined
  let hook: { code?: string; at: number } | undefined
  for (const event of block.events) {
    if (event.k === 'call') last = event.after ?? event.before ?? last
    if (event.k === 'hook' && event.ok) hook = { code: event.code, at: event.at }
  }
  const hooks = block.settings.hooks ? 'hooks installed' : 'hooks off'
  const lastHook = hook
    ? `last hook ${spaced(hook.code ?? 'received')} ${seconds(end - hook.at)} before`
    : 'no hook received in the window'
  const body = last
    ? `${last.alive ? 'pty alive' : 'pty gone'} · foreground ${last.agent === 'none' ? 'shell' : last.agent}`
    : 'state not recorded'
  return `${block.pane} at the failure: ${hooks} · ${lastHook} · ${body}`
}

function background(block: IncidentBlock): string {
  const byMethod = new Map<string, Map<string, number>>()
  for (const [key, n] of Object.entries(block.counts)) {
    const dot = key.lastIndexOf('.')
    const method = key.slice(0, dot)
    const result = key.slice(dot + 1)
    const results = byMethod.get(method) ?? new Map<string, number>()
    results.set(result, n)
    byMethod.set(method, results)
  }
  const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)
  const parts = [...byMethod.entries()]
    .sort((a, b) => total(b[1]) - total(a[1]))
    .slice(0, 6)
    .map(([method, results]) => {
      const ok = results.get('ok') ?? 0
      const bad = [...results.entries()]
        .filter(([name]) => name !== 'ok')
        .map(([name, n]) => `${n} ${spaced(name)}`)
      return `${method} ${[`${ok} ok`, ...bad].join(' / ')}`
    })
  return `Background (${block.sinceMin} min): ${parts.join(' · ') || 'no calls'}`
}

const fenceless = (text: string): string => text.trim().replace(/`{3,}/g, "'''")

export function incidentText(block: IncidentBlock, words: IncidentWords): string {
  const settings = Object.entries(block.settings)
    .map(([key, on]) => `${key}=${on ? 'on' : 'off'}`)
    .join(' ')
  const callers = block.events.some((e) => e.k === 'call' && e.from)
  const unseen = block.unseen.map((u) => UNSEEN_WORDS[u] ?? spaced(u)).join(', ')
  return [
    `**${headline(block)}**`,
    `Ostia ${block.app} · ${block.platform} · agent ${block.agent.kind}${block.agent.version ? ` ${block.agent.version}` : ''}`,
    `Settings: ${settings || 'none'}`,
    `Panes: ${callers ? 'P1 = caller · ' : ''}${block.pane} = target`,
    '',
    `What happened (their words): ${fenceless(words.happened) || '(not written)'}`,
    `What they expected: ${fenceless(words.expected) || '(not written)'}`,
    '',
    'Timeline (seconds before the report)',
    ...timeline(block),
    '',
    targetLine(block),
    `Ostia could not see: ${unseen || 'nothing recorded'}`,
    background(block),
    '',
    `\`\`\`${INCIDENT_BLOCK_TAG} json`,
    JSON.stringify(block, null, 2),
    '```',
  ].join('\n')
}
