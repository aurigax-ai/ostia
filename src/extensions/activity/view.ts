import type { HookAgent } from '../../shared/agentPlugins'
import type { ActivityEvent, ActivityKind, ToolKind } from './hookEvent'

export const AGENT_STATES = ['working', 'waiting', 'done', 'error'] as const

export type AgentState = (typeof AGENT_STATES)[number]

export const EARLIER_TURNS_MAX = 20
export const TURN_EVENTS_MAX = 200

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

export interface WorkspaceView {
  workspaceId: string
  name: string
  last: number
  agents: AgentView[]
}

export interface PanelModel {
  showActivity: boolean
  workspaces: WorkspaceView[]
}

export interface ViewSources {
  showActivity: boolean
  workspaces: readonly OpenWorkspace[]
  panes: readonly OpenPane[]
  events: (workspaceId: string) => readonly ActivityEvent[]
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

export function panelModel(sources: ViewSources): PanelModel {
  const panes = new Map(sources.panes.map((pane) => [pane.paneId, pane]))
  const workspaces: WorkspaceView[] = []
  for (const workspace of sources.workspaces) {
    const byPane = new Map<string, ActivityEvent[]>()
    for (const event of sources.events(workspace.workspaceId)) {
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
    if (agents.length === 0) continue
    agents.sort(mostRecentFirst)
    workspaces.push({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      last: agents[0].last,
      agents,
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
