import type { HookAgent } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import {
  type ActivityEvent,
  type ActivityHost,
  type ActivityKind,
  type ActivityNote,
  type ActivityRecord,
  type BusMessageKind,
  type HostKind,
  isOpenNeedsYou,
  type ToolKind,
} from './hookEvent'

const AGENT_STATES = ['working', 'waiting', 'done', 'error'] as const

type AgentState = (typeof AGENT_STATES)[number]

export const TURN_PAGE = 20
export const STREAM_PAGE = 40
export const STREAM_LIMIT_KEY = 'stream'
const NOTES_SHOWN_MAX = 20
const TURN_EVENTS_MAX = 200
const BULK_WINDOW_MS = 5000

export type Limits = Readonly<Record<string, number>>

export function agentLimitKey(paneId: string): string {
  return `agent:${paneId}`
}

function pageSize(key: string): number {
  return key === STREAM_LIMIT_KEY ? STREAM_PAGE : TURN_PAGE
}

export function widen(limits: Map<string, number>, key: string, loaded: number): boolean {
  const have = limits.get(key) ?? pageSize(key)
  if (have > loaded) return false
  limits.set(key, have + pageSize(key))
  return true
}

export function limitsDigest(limits: Limits): string {
  return Object.entries(limits)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

export interface OpenWorkspace {
  workspaceId: string
  name: string
}

export interface OpenPane {
  paneId: string
  agentState?: string
  title?: string
}

export interface EventView {
  t: number
  kind: ActivityKind
  tool?: ToolKind
  text?: string
}

type WrapperKind = 'pasted' | 'task' | 'reminder' | 'message'

export interface PromptWrapper {
  kind: WrapperKind
  from?: PaneLabel
}

export interface TurnView {
  start: number
  prompt?: string
  wrapper?: PromptWrapper
  recap?: string
  events: EventView[]
}

export interface AgentView {
  paneId: string
  label: PaneLabel
  state?: AgentState
  recap?: string
  last: number
  current: TurnView
  earlier: TurnView[]
  more: number
}

export interface NoteView {
  id: string
  t: number
  text: string
  needsYou: boolean
  done: boolean
  link?: string
  pane: string
  label: PaneLabel
  open: boolean
}

export interface PaneLabel {
  agent?: HookAgent
  title?: string
  n: number
}

export type StreamEndpoint =
  | { kind: 'pane'; label: PaneLabel }
  | { kind: 'ostia' | 'extension' | 'elsewhere' }

export interface StreamRow {
  id: string
  t: number
  host: HostKind
  subject: PaneLabel
  state?: string
  from?: StreamEndpoint
  to?: StreamEndpoint
  message?: BusMessageKind
  folder?: string
  panes?: PaneLabel[]
}

export interface WorkspaceView {
  workspaceId: string
  agents: AgentView[]
  notes: NoteView[]
  stream: StreamRow[]
  streamMore: number
}

export interface PanelModel {
  showActivity: boolean
  workspace: WorkspaceView | null
}

export interface ViewSources {
  showActivity: boolean
  workspace: OpenWorkspace | undefined
  panes: readonly OpenPane[]
  limits?: Limits
  events: (workspaceId: string) => readonly ActivityRecord[]
}

const ACTION_CATEGORIES = [
  'command',
  'edit',
  'read',
  'search',
  'subagent',
  'skill',
  'web',
  'other',
] as const

export type ActionCategory = (typeof ACTION_CATEGORIES)[number]

const SKILL_TOOL = 'Skill'

export function actionCategory(event: EventView): ActionCategory | null {
  if (event.kind !== 'tool') return null
  if (event.tool === 'other' && event.text === SKILL_TOOL) return 'skill'
  return event.tool ?? 'other'
}

export function actionCounts(
  events: readonly EventView[],
): { category: ActionCategory; count: number }[] {
  const counts = new Map<ActionCategory, number>()
  for (const event of events) {
    const category = actionCategory(event)
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return ACTION_CATEGORIES.flatMap((category) => {
    const count = counts.get(category)
    return count ? [{ category, count }] : []
  })
}

function eventView(event: ActivityEvent): EventView {
  const view: EventView = { t: event.t, kind: event.kind }
  if (event.tool) view.tool = event.tool
  if (event.text) view.text = event.text
  return view
}

const WRAPPER_TAGS: readonly { name: string; kind: WrapperKind }[] = [
  { name: 'pasted_content', kind: 'pasted' },
  { name: 'task-notification', kind: 'task' },
  { name: 'system-reminder', kind: 'reminder' },
  { name: 'ostia-bus-messages', kind: 'message' },
]

function wrapperPattern(name: string): RegExp {
  return new RegExp(`^<${name}(?:\\s[^<>]*)?>(?:\\s*</${name}\\s*>)?$`)
}

const WRAPPER_PATTERNS = WRAPPER_TAGS.map(({ name, kind }) => ({
  pattern: wrapperPattern(name),
  kind,
}))
const BUS_MESSAGE_TAG = /^<message\s[^<>]*\bfrom="([^"]+)"[^<>]*>(?:\s*<\/message\s*>)?$/

function wrapperOf(text: string, label: (pane: string) => PaneLabel): PromptWrapper | null {
  const line = text.trim()
  const from = BUS_MESSAGE_TAG.exec(line)?.[1]
  if (from) return { kind: 'message', from: label(from) }
  const tag = WRAPPER_PATTERNS.find(({ pattern }) => pattern.test(line))
  return tag ? { kind: tag.kind } : null
}

const UNLABELLED = (): PaneLabel => ({ n: 1 })

export function turnsOf(
  events: readonly ActivityEvent[],
  label: (pane: string) => PaneLabel = UNLABELLED,
): TurnView[] {
  const turns: TurnView[] = []
  let open: TurnView | null = null
  for (const event of events) {
    if (event.kind === 'prompt' || open === null) {
      open = { start: event.t, events: [] }
      turns.push(open)
    }
    open.events.push(eventView(event))
    if (event.kind === 'prompt' && event.text) {
      const wrapper = wrapperOf(event.text, label)
      if (wrapper) open.wrapper = wrapper
      else open.prompt = event.text
    }
    if (event.kind === 'stop') {
      if (event.text) open.recap = event.text
      open = null
    }
  }
  return turns.map((turn) => ({ ...turn, events: turn.events.slice(-TURN_EVENTS_MAX) }))
}

function agentState(raw: string | undefined): AgentState | undefined {
  return AGENT_STATES.find((state) => state === raw)
}

function pageOf(limits: Limits, key: string): number {
  return limits[key] ?? pageSize(key)
}

function agentView(
  pane: OpenPane,
  events: readonly ActivityEvent[],
  label: (pane: string) => PaneLabel,
  limits: Limits,
): AgentView | null {
  const latest = events[events.length - 1]
  if (!latest) return null
  const turns = turnsOf(events, label)
  const current = turns[turns.length - 1]
  const recap = [...turns].reverse().find((turn) => turn.recap)?.recap
  const state = agentState(pane.agentState)
  const older = turns.slice(0, -1).reverse()
  const earlier = older.slice(0, pageOf(limits, agentLimitKey(pane.paneId)))
  return {
    paneId: pane.paneId,
    label: label(pane.paneId),
    ...(state ? { state } : {}),
    ...(recap ? { recap } : {}),
    last: latest.t,
    current,
    earlier,
    more: older.length - earlier.length,
  }
}

function noteView(note: ActivityNote, label: PaneLabel, open: boolean): NoteView {
  return {
    id: note.id,
    t: note.t,
    text: note.text,
    needsYou: note.needsYou === true,
    done: note.doneAt !== undefined,
    ...(note.link ? { link: note.link } : {}),
    pane: note.pane,
    label,
    open,
  }
}

function notesOf(
  notes: readonly ActivityNote[],
  label: (pane: string) => PaneLabel,
  panes: ReadonlyMap<string, OpenPane>,
): NoteView[] {
  return notes
    .filter((note) => !isOpenNeedsYou(note))
    .reverse()
    .slice(0, NOTES_SHOWN_MAX)
    .map((note) => noteView(note, label(note.pane), panes.has(note.pane)))
}

function paneLabels(
  events: readonly ActivityEvent[],
  hosts: readonly ActivityHost[],
  notes: readonly ActivityNote[],
  panes: ReadonlyMap<string, OpenPane>,
): (pane: string) => PaneLabel {
  const firstSeen = new Map<string, number>()
  const agents = new Map<string, HookAgent>()
  const see = (pane: string | undefined, t: number): void => {
    if (pane && !firstSeen.has(pane)) firstSeen.set(pane, t)
  }
  for (const event of events) {
    see(event.pane, event.t)
    agents.set(event.pane, event.agent)
  }
  for (const host of hosts) {
    see(host.pane, host.t)
    if (host.host === 'bus') {
      see(host.from, host.t)
      see(host.to, host.t)
    }
  }
  for (const note of notes) see(note.pane, note.t)
  const ordered = [...firstSeen.keys()].sort(
    (a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0) || (a < b ? -1 : 1),
  )
  const perAgent = new Map<HookAgent | undefined, number>()
  const perTitle = new Map<string, number>()
  const labels = new Map<string, PaneLabel>()
  for (const pane of ordered) {
    const agent = agents.get(pane)
    const byAgent = (perAgent.get(agent) ?? 0) + 1
    perAgent.set(agent, byAgent)
    const title = panes.get(pane)?.title?.trim()
    const byTitle = title ? (perTitle.get(title) ?? 0) + 1 : 0
    if (title) perTitle.set(title, byTitle)
    labels.set(pane, {
      ...(agent ? { agent } : {}),
      ...(title ? { title } : {}),
      n: title ? byTitle : byAgent,
    })
  }
  return (pane) => {
    const exact = labels.get(pane)
    if (exact) return exact
    const matches = ordered.filter((id) => id.startsWith(pane))
    return (matches.length === 1 && labels.get(matches[0])) || { n: 1 }
  }
}

const OTHER_ENDPOINTS: Record<string, 'ostia' | 'extension' | 'elsewhere'> = {
  '@ostia': 'ostia',
  '@extension': 'extension',
  '@elsewhere': 'elsewhere',
}

function endpointView(id: string, label: (pane: string) => PaneLabel): StreamEndpoint {
  const other = OTHER_ENDPOINTS[id]
  return other ? { kind: other } : { kind: 'pane', label: label(id) }
}

function bulkKey(host: ActivityHost): string {
  if (host.host === 'folder') return `folder:${host.folder}`
  return host.host === 'state' ? `state:${host.state}` : host.host
}

interface Bulk {
  key: string
  row: StreamRow
  panes: Set<string>
  start: number
}

function streamOf(
  hosts: readonly ActivityHost[],
  label: (pane: string) => PaneLabel,
  limit: number,
): { rows: StreamRow[]; more: number } {
  const rows: StreamRow[] = []
  const messages = new Map<string, StreamRow>()
  let bulk = null as Bulk | null
  for (const host of hosts) {
    const row: StreamRow = { id: host.id, t: host.t, host: host.host, subject: label(host.pane) }
    if (host.state) row.state = host.state
    if (host.folder) row.folder = host.folder
    if (host.host === 'bus') {
      if (host.from) row.from = endpointView(host.from, label)
      if (host.to) row.to = endpointView(host.to, label)
      if (host.message) row.message = host.message
      const known = host.ref ? messages.get(host.ref) : undefined
      if (known) {
        if (host.state) known.state = host.state
        continue
      }
      if (host.ref) messages.set(host.ref, row)
    } else {
      const key = bulkKey(host)
      if (
        bulk?.key === key &&
        rows[rows.length - 1] === bulk.row &&
        !bulk.panes.has(host.pane) &&
        host.t - bulk.start <= BULK_WINDOW_MS
      ) {
        bulk.row.t = host.t
        bulk.row.panes = [...(bulk.row.panes ?? [bulk.row.subject]), label(host.pane)]
        bulk.panes.add(host.pane)
        continue
      }
      bulk = { key, row, panes: new Set([host.pane]), start: host.t }
    }
    rows.push(row)
  }
  const newest = rows.reverse()
  return { rows: newest.slice(0, limit), more: Math.max(0, newest.length - limit) }
}

export function panelModel(sources: ViewSources): PanelModel {
  const { workspace, showActivity, limits = {} } = sources
  if (!workspace) return { showActivity, workspace: null }
  const panes = new Map(sources.panes.map((pane) => [pane.paneId, pane]))
  const byPane = new Map<string, ActivityEvent[]>()
  const hosts: ActivityHost[] = []
  const noteRecords: ActivityNote[] = []
  for (const record of sources.events(workspace.workspaceId)) {
    if (record.kind === 'note') {
      noteRecords.push(record)
    } else if (record.kind === 'host') {
      hosts.push(record)
    } else {
      const known = byPane.get(record.pane)
      if (known) known.push(record)
      else byPane.set(record.pane, [record])
    }
  }
  const label = paneLabels([...byPane.values()].flat(), hosts, noteRecords, panes)
  const agents: AgentView[] = []
  for (const [paneId, events] of byPane) {
    const pane = panes.get(paneId)
    const view = pane ? agentView(pane, events, label, limits) : null
    if (view) agents.push(view)
  }
  const notes = notesOf(noteRecords, label, panes)
  const { rows: stream, more: streamMore } = streamOf(
    hosts,
    label,
    pageOf(limits, STREAM_LIMIT_KEY),
  )
  if (agents.length === 0 && notes.length === 0 && stream.length === 0) {
    return { showActivity, workspace: null }
  }
  return {
    showActivity,
    workspace: { workspaceId: workspace.workspaceId, agents, notes, stream, streamMore },
  }
}

export function streamRowKey(row: StreamRow): string {
  return `host:${row.id}`
}

export function groupKey(paneId: string, turnStart: number): string {
  return `${paneId}:${turnStart}`
}

export function liveKeys(workspace: WorkspaceView | null): {
  panes: Set<string>
  notes: Set<string>
  groups: Set<string>
  limits: Set<string>
} {
  const live = {
    panes: new Set<string>(),
    notes: new Set<string>(),
    groups: new Set<string>(),
    limits: new Set<string>([STREAM_LIMIT_KEY]),
  }
  for (const note of workspace?.notes ?? []) live.notes.add(note.id)
  for (const row of workspace?.stream ?? []) if (row.panes) live.groups.add(streamRowKey(row))
  for (const agent of workspace?.agents ?? []) {
    live.panes.add(agent.paneId)
    live.limits.add(agentLimitKey(agent.paneId))
    for (const turn of [agent.current, ...agent.earlier]) {
      live.groups.add(groupKey(agent.paneId, turn.start))
    }
  }
  return live
}

export type AgeUnit = 'now' | 'minutes' | 'hours' | 'days'

export function ageOf(then: number, now: number): { unit: AgeUnit; count: number } {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return { unit: 'now', count: 0 }
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? { unit: 'hours', count: hours }
    : { unit: 'days', count: Math.floor(hours / 24) }
}
