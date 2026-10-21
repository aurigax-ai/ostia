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

export const EARLIER_TURNS_MAX = 20
const NOTES_SHOWN_MAX = 20
const STREAM_ROWS_MAX = 100
const TURN_EVENTS_MAX = 200

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

export interface TurnView {
  start: number
  prompt?: string
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
}

export interface WorkspaceView {
  workspaceId: string
  agents: AgentView[]
  notes: NoteView[]
  stream: StreamRow[]
}

export interface PanelModel {
  showActivity: boolean
  workspace: WorkspaceView | null
}

export interface ViewSources {
  showActivity: boolean
  workspace: OpenWorkspace | undefined
  panes: readonly OpenPane[]
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

export function turnsOf(events: readonly ActivityEvent[]): TurnView[] {
  const turns: TurnView[] = []
  let open: TurnView | null = null
  for (const event of events) {
    if (event.kind === 'prompt' || open === null) {
      open = { start: event.t, events: [] }
      turns.push(open)
    }
    open.events.push(eventView(event))
    if (event.kind === 'prompt' && event.text) open.prompt = event.text
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

function agentView(
  pane: OpenPane,
  events: readonly ActivityEvent[],
  label: PaneLabel,
): AgentView | null {
  const latest = events[events.length - 1]
  if (!latest) return null
  const turns = turnsOf(events)
  const current = turns[turns.length - 1]
  const recap = [...turns].reverse().find((turn) => turn.recap)?.recap
  const state = agentState(pane.agentState)
  return {
    paneId: pane.paneId,
    label,
    ...(state ? { state } : {}),
    ...(recap ? { recap } : {}),
    last: latest.t,
    current,
    earlier: turns.slice(0, -1).reverse().slice(0, EARLIER_TURNS_MAX),
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
  return (pane) => labels.get(pane) ?? { n: 1 }
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

function streamOf(hosts: readonly ActivityHost[], label: (pane: string) => PaneLabel): StreamRow[] {
  const rows: StreamRow[] = []
  const messages = new Map<string, StreamRow>()
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
    }
    rows.push(row)
  }
  return rows.reverse().slice(0, STREAM_ROWS_MAX)
}

export function panelModel(sources: ViewSources): PanelModel {
  const { workspace, showActivity } = sources
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
    const view = pane ? agentView(pane, events, label(paneId)) : null
    if (view) agents.push(view)
  }
  const notes = notesOf(noteRecords, label, panes)
  const stream = streamOf(hosts, label)
  if (agents.length === 0 && notes.length === 0 && stream.length === 0) {
    return { showActivity, workspace: null }
  }
  return { showActivity, workspace: { workspaceId: workspace.workspaceId, agents, notes, stream } }
}

export function groupKey(paneId: string, turnStart: number): string {
  return `${paneId}:${turnStart}`
}

export function liveKeys(workspace: WorkspaceView | null): {
  panes: Set<string>
  notes: Set<string>
  groups: Set<string>
} {
  const live = { panes: new Set<string>(), notes: new Set<string>(), groups: new Set<string>() }
  for (const note of workspace?.notes ?? []) live.notes.add(note.id)
  for (const agent of workspace?.agents ?? []) {
    live.panes.add(agent.paneId)
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
