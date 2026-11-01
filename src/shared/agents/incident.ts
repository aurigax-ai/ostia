import { z } from 'zod'

export const INCIDENT_WINDOW_MS = 5 * 60_000
export const INCIDENT_EVENTS_MAX = 50
export const INCIDENT_PANES_MAX = 32
export const INCIDENT_STALL_MS = 8000
export const INCIDENT_KEPT_MAX = 20
export const INCIDENT_KEEP_MS = 30 * 24 * 3600_000
export const INCIDENT_PERIODS = ['24h', '7d', '30d'] as const
export type IncidentPeriod = (typeof INCIDENT_PERIODS)[number]
export const INCIDENT_PERIOD_MS: Record<IncidentPeriod, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': INCIDENT_KEEP_MS,
}
export const INCIDENT_BLOCK_TAG = 'ostia-incident'
export const INCIDENT_WORDS_MAX = 2000

const CODE = z.string().regex(/^[a-z][a-z.-]{0,40}$/)
const METHOD = z.string().regex(/^[a-z][A-Za-z.]{0,60}$/)
const ALIAS = z.string().regex(/^P[1-9][0-9]?$/)
const MS = z
  .number()
  .int()
  .min(0)
  .max(INCIDENT_WINDOW_MS * 2)

const COUNT_KEY = z.string().regex(/^[a-z][A-Za-z.-]{0,70}$/)

const snapshotSchema = z.strictObject({
  agent: CODE,
  state: CODE,
  drafting: z.boolean(),
  mail: z.number().int().min(0).max(999),
  alive: z.boolean(),
})

const incidentEventSchema = z.discriminatedUnion('k', [
  z.strictObject({
    k: z.literal('call'),
    at: MS,
    method: METHOD,
    from: ALIAS.optional(),
    phase: z.enum(['start', 'end', 'cancel', 'phase']),
    name: CODE.optional(),
    ms: MS.optional(),
    code: CODE.optional(),
    before: snapshotSchema.optional(),
    after: snapshotSchema.optional(),
  }),
  z.strictObject({ k: z.literal('state'), at: MS, to: CODE, from: CODE.optional() }),
  z.strictObject({ k: z.literal('hook'), at: MS, ok: z.boolean(), code: CODE.optional() }),
  z.strictObject({ k: z.literal('mail'), at: MS, code: CODE, age: MS.optional() }),
  z.strictObject({ k: z.literal('wake'), at: MS, code: CODE, ms: MS }),
])

export type IncidentEvent = z.infer<typeof incidentEventSchema>
export type IncidentSnapshot = z.infer<typeof snapshotSchema>

export const incidentBlockSchema = z.strictObject({
  version: z.literal(1),
  app: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
  platform: CODE,
  agent: z.strictObject({
    kind: CODE,
    version: z
      .string()
      .regex(/^[0-9A-Za-z.+-]{1,40}$/)
      .optional(),
  }),
  settings: z.record(CODE, z.boolean()),
  pane: ALIAS,
  trigger: CODE,
  events: z.array(incidentEventSchema).max(INCIDENT_EVENTS_MAX),
  unseen: z.array(CODE).max(20),
  counts: z.record(COUNT_KEY, z.number().int().min(0).max(1_000_000)),
  sinceMin: z.number().int().min(0).max(100_000),
})

export type IncidentBlock = z.infer<typeof incidentBlockSchema>

export interface IncidentSummary {
  ref: string
  trigger: string
  agent: string
  ageMs: number
  count: number
}

export const TRIGGER_WORDS: Readonly<Record<string, string>> = {
  'call-open': 'A call never returned',
  'slow-call': 'A call was slow',
  'call-cancelled': 'A call was cancelled',
  'not-submitted': 'Enter not submitted',
  'not-queued': 'Message not queued',
  'not-started': 'Agent did not start',
  'not-recorded': 'Result not recorded',
  'still-open': 'Pane did not close',
  'wake-not-ready': 'Wake never got ready',
  'lease-timeout': 'Mail waited too long',
  'pane-closed': 'Mail target closed',
  'agent-refused': 'Agent refused mail',
  'inbox-full': 'Inbox full',
  'hook-failed': 'A hook failed',
  'folder-not-trusted': 'Agent run refused: folder not trusted',
  'undelivered-hooks-off': 'Mail not delivered: hooks off',
  'undelivered-idle-no-wake': 'Mail not delivered: agent idle, not woken',
  'undelivered-hibernated': 'Mail not delivered: agent hibernated',
  'undelivered-no-agent': 'Mail not delivered: no agent in the pane',
  'undelivered-rate-limited': 'Mail not delivered: wake limit reached',
}

export function triggerWords(code: string): string {
  return TRIGGER_WORDS[code] ?? code.replaceAll('-', ' ')
}

interface IncidentWords {
  happened: string
  expected: string
}

interface IncidentReport {
  text: string
  redacted: number
}

export interface IncidentApi {
  list: (period: IncidentPeriod) => Promise<IncidentSummary[]>
  report: (ref: string, words: IncidentWords) => Promise<IncidentReport | null>
  save: () => Promise<boolean>
  openIssue: () => Promise<boolean>
  clear: () => Promise<boolean>
}
