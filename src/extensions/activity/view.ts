import type { HookAgent } from '../../shared/agentPlugins'
import {
  type ActivityEvent,
  type ActivityKind,
  type ActivityNote,
  type ActivityRecord,
  type ToolKind,
  isOpenNeedsYou,
} from './hookEvent'

const AGENT_STATES = ['working', 'waiting', 'done', 'error'] as const

type AgentState = (typeof AGENT_STATES)[number]

export const EARLIER_TURNS_MAX = 20
const NOTES_SHOWN_MAX = 20
const TURN_EVENTS_MAX = 200

export interface OpenWorkspace {
  workspaceId: string
  name: string
}

export interface OpenPane {
  paneId: string
  agentState?: string
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
  agent: HookAgent
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
}

export interface WorkspaceView {
  workspaceId: string
  name: string
  last: number
  agents: AgentView[]
  notes: NoteView[]
}

export interface PanelModel {
  showActivity: boolean
  workspaces: WorkspaceView[]
}

export interface ViewSources {
  showActivity: boolean
  workspaces: readonly OpenWorkspace[]
  panes: readonly OpenPane[]
  events: (workspaceId: string) => readonly ActivityRecord[]
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

function agentView(pane: OpenPane, events: readonly ActivityEvent[]): AgentView | null {
  const latest = events[events.length - 1]
  if (!latest) return null
  const turns = turnsOf(events)
  const current = turns[turns.length - 1]
  const recap = [...turns].reverse().find((turn) => turn.recap)?.recap
  const state = agentState(pane.agentState)
  return {
    paneId: pane.paneId,
    agent: latest.agent,
    ...(state ? { state } : {}),
    ...(recap ? { recap } : {}),
    last: latest.t,
    current,
    earlier: turns.slice(0, -1).reverse().slice(0, EARLIER_TURNS_MAX),
  }
}

const mostRecentFirst = (a: { last: number }, b: { last: number }): number => b.last - a.last

function noteView(note: ActivityNote): NoteView {
  return {
    id: note.id,
    t: note.t,
    text: note.text,
    needsYou: note.needsYou === true,
    done: note.doneAt !== undefined,
    ...(note.link ? { link: note.link } : {}),
  }
}

function notesOf(records: readonly ActivityRecord[]): NoteView[] {
  const notes = records.filter((r): r is ActivityNote => r.kind === 'note')
  const open = notes.filter(isOpenNeedsYou).reverse()
  const rest = notes
    .filter((note) => !isOpenNeedsYou(note))
    .reverse()
    .slice(0, NOTES_SHOWN_MAX)
  return [...open, ...rest].map(noteView)
}

export function panelModel(sources: ViewSources): PanelModel {
  const panes = new Map(sources.panes.map((pane) => [pane.paneId, pane]))
  const workspaces: WorkspaceView[] = []
  for (const workspace of sources.workspaces) {
    const byPane = new Map<string, ActivityEvent[]>()
    const records = sources.events(workspace.workspaceId)
    for (const event of records) {
      if (event.kind === 'note') continue
      const known = byPane.get(event.pane)
      if (known) known.push(event)
      else byPane.set(event.pane, [event])
    }
    const agents: AgentView[] = []
    for (const [paneId, events] of byPane) {
      const pane = panes.get(paneId)
      const view = pane ? agentView(pane, events) : null
      if (view) agents.push(view)
    }
    const notes = notesOf(records)
    if (agents.length === 0 && notes.length === 0) continue
    agents.sort(mostRecentFirst)
    workspaces.push({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      last: Math.max(agents[0]?.last ?? 0, ...notes.map((n) => n.t)),
      agents,
      notes,
    })
  }
  return { showActivity: sources.showActivity, workspaces: workspaces.sort(mostRecentFirst) }
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
