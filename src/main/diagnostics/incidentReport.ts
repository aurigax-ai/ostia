import {
  INCIDENT_BLOCK_TAG,
  type IncidentBlock,
  type IncidentEvent,
  incidentBlockSchema,
} from '../../shared/agents/incident'
import type { IncidentTake } from './incidentTimeline'

export interface IncidentFacts {
  app: string
  platform: string
  agent: { kind: string; version?: string }
  settings: Record<string, boolean>
  counts: Record<string, number>
  unseen: string[]
}

export interface IncidentWords {
  happened: string
  expected: string
}

export function incidentBlock(take: IncidentTake, facts: IncidentFacts): IncidentBlock {
  const aliases = new Map<string, string>([[take.paneId, 'P1']])
  for (const caller of take.callers) {
    if (!aliases.has(caller)) aliases.set(caller, `P${aliases.size + 1}`)
  }
  const first = take.events[0]?.at ?? 0
  const events = take.events.map((event): IncidentEvent => {
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
    pane: 'P1',
    trigger: take.trigger,
    events,
    unseen: facts.unseen,
    counts: facts.counts,
  })
}

function line(event: IncidentEvent): string {
  const at = `+${(event.at / 1000).toFixed(1)}s`
  switch (event.k) {
    case 'call': {
      const who = event.from ? ` from ${event.from}` : ''
      const detail = [
        event.name,
        event.ms === undefined ? undefined : `${event.ms} ms`,
        event.code,
        event.before ? `before ${snap(event.before)}` : undefined,
        event.after ? `after ${snap(event.after)}` : undefined,
      ]
        .filter(Boolean)
        .join(', ')
      return `${at}  ${event.method}${who} ${event.phase}${detail ? ` (${detail})` : ''}`
    }
    case 'state':
      return `${at}  state ${event.from ? `${event.from} -> ` : ''}${event.to}`
    case 'hook':
      return `${at}  hook ${event.ok ? 'ok' : `failed${event.code ? ` (${event.code})` : ''}`}`
    case 'mail':
      return `${at}  mail ${event.code}${event.age === undefined ? '' : ` (${event.age} ms old)`}`
    case 'wake':
      return `${at}  wake ${event.code} (${event.ms} ms)`
  }
}

function snap(s: { agent: string; state: string; drafting: boolean; mail: number }): string {
  return `${s.agent}/${s.state}${s.drafting ? '/draft' : ''}/mail ${s.mail}`
}

const fenceless = (text: string): string => text.trim().replace(/`{3,}/g, "'''")

export function incidentText(block: IncidentBlock, words: IncidentWords): string {
  const settings = Object.entries(block.settings)
    .map(([key, on]) => `${key}=${on}`)
    .join(', ')
  const counts = Object.entries(block.counts)
    .map(([key, n]) => `${key} ${n}`)
    .join(', ')
  const parts = [
    '## What happened',
    fenceless(words.happened) || '(not written)',
    '',
    '## What I expected',
    fenceless(words.expected) || '(not written)',
    '',
    '## Environment',
    `Ostia ${block.app} on ${block.platform}; agent ${block.agent.kind}${block.agent.version ? ` ${block.agent.version}` : ''}`,
    `Settings: ${settings || 'none'}`,
    '',
    `## Timeline (${block.pane}, trigger ${block.trigger})`,
    ...block.events.map(line),
    '',
    '## What Ostia could not see',
    ...block.unseen.map((u) => `- ${u}`),
    '',
    `Totals: ${counts || 'none'}`,
    '',
    `\`\`\`${INCIDENT_BLOCK_TAG} json`,
    JSON.stringify(block, null, 2),
    '```',
  ]
  return parts.join('\n')
}
