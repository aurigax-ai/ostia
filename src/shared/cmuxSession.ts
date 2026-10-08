import { type AgentResume, parseAgentResume } from './agentResume'

export const CMUX_SESSION_FILE = 'Library/Application Support/cmux/session-com.cmuxterm.app.json'

const CMUX_SESSION_VERSION = 1

const TEXT_MAX = 256
const PATH_MAX = 4096
const DEPTH_MAX = 32

type CmuxSplitDirection = 'horizontal' | 'vertical'

export interface CmuxSurface {
  type: string
  title?: string
  directory?: string
  url?: string
  filePath?: string
  agent?: string
  resume?: AgentResume
  scrollback?: true
  remote?: true
  browserHistory?: true
  focused?: true
}

export interface CmuxPaneLayout {
  type: 'pane'
  surfaces: CmuxSurface[]
  selected: number
}

interface CmuxSplitLayout {
  type: 'split'
  direction: CmuxSplitDirection
  divider: number
  first: CmuxLayout
  second: CmuxLayout
}

export type CmuxLayout = CmuxPaneLayout | CmuxSplitLayout

export interface CmuxWorkspace {
  title?: string
  description?: string
  pinned?: true
  group?: string
  directory: string
  layout: CmuxLayout
  remote?: true
  canvas?: true
}

interface CmuxWindow {
  workspaces: CmuxWorkspace[]
}

export interface CmuxSession {
  windows: CmuxWindow[]
}

export type CmuxSessionError =
  | 'bad-path'
  | 'outside-home'
  | 'not-found'
  | 'unreadable'
  | 'too-large'
  | 'invalid'
  | 'unsupported-version'

export type CmuxSessionRead =
  | { ok: true; path: string; session: CmuxSession }
  | { ok: false; error: CmuxSessionError; path?: string }

export type CmuxLoss =
  | 'scrollback'
  | 'agent-resume'
  | 'agent'
  | 'surface'
  | 'remote'
  | 'canvas'
  | 'browser-history'
  | 'group'
  | 'panes'
  | 'layout'

export interface CmuxLossEntry {
  workspace: string
  pane?: string
  loss: CmuxLoss
  detail?: string
}

interface CmuxImportedEntry {
  workspaceId: string
  name: string
  panes: number
  window: number
}

export type CmuxSkipReason = 'exists' | 'limit' | 'window'

export interface CmuxSkippedEntry {
  name: string
  reason: CmuxSkipReason
  window: number
}

export interface CmuxImportReport {
  path: string
  imported: CmuxImportedEntry[]
  skipped: CmuxSkippedEntry[]
  notCarried: CmuxLossEntry[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown, max = TEXT_MAX): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function absolutePath(v: unknown): string | undefined {
  const path = text(v, PATH_MAX)
  return path?.startsWith('/') ? path : undefined
}

function webUrl(v: unknown): string | undefined {
  const url = text(v, PATH_MAX)
  return url && /^https?:\/\//i.test(url) ? url : undefined
}

function hasEntries(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

function parseSurface(panel: Record<string, unknown>, focusedId: unknown): CmuxSurface | null {
  const type = text(panel.type)
  if (!type) return null
  const terminal = isRecord(panel.terminal) ? panel.terminal : {}
  const surface: CmuxSurface = { type }
  const title = text(panel.customTitle)
  if (title) surface.title = title
  const directory = absolutePath(panel.directory) ?? absolutePath(terminal.workingDirectory)
  if (directory) surface.directory = directory
  if (panel.id === focusedId) surface.focused = true
  if (type === 'terminal') {
    const agent = isRecord(terminal.agent) ? terminal.agent : null
    const kind = agent ? text(agent.kind) : undefined
    if (agent && kind) {
      surface.agent = kind
      const resume = parseAgentResume({ agent: kind, id: agent.sessionId })
      if (resume) surface.resume = resume
    }
    if (typeof terminal.scrollback === 'string' && terminal.scrollback.length > 0) {
      surface.scrollback = true
    }
    if (terminal.isRemoteTerminal === true) surface.remote = true
  } else if (type === 'browser') {
    const browser = isRecord(panel.browser) ? panel.browser : {}
    const url = webUrl(browser.urlString)
    if (url) surface.url = url
    if (hasEntries(browser.backHistoryURLStrings) || hasEntries(browser.forwardHistoryURLStrings)) {
      surface.browserHistory = true
    }
    const pageTitle = text(panel.title)
    if (!surface.title && pageTitle) surface.title = pageTitle
  } else if (type === 'markdown' || type === 'filepreview') {
    const file = type === 'markdown' ? panel.markdown : panel.filePreview
    const filePath = isRecord(file) ? absolutePath(file.filePath) : undefined
    if (filePath) surface.filePath = filePath
  }
  return surface
}

interface PanelLookup {
  panels: Map<string, Record<string, unknown>>
  used: Set<string>
  focusedId: unknown
}

function parsePane(raw: unknown, lookup: PanelLookup): CmuxPaneLayout | null {
  if (!isRecord(raw) || !Array.isArray(raw.panelIds)) return null
  const surfaces: CmuxSurface[] = []
  let selected = 0
  for (const id of raw.panelIds) {
    if (typeof id !== 'string' || lookup.used.has(id)) continue
    const panel = lookup.panels.get(id)
    const surface = panel ? parseSurface(panel, lookup.focusedId) : null
    if (!surface) continue
    lookup.used.add(id)
    if (id === raw.selectedPanelId) selected = surfaces.length
    surfaces.push(surface)
  }
  return { type: 'pane', surfaces, selected }
}

function parseLayout(raw: unknown, lookup: PanelLookup, depth: number): CmuxLayout | null {
  if (!isRecord(raw) || depth > DEPTH_MAX) return null
  if (raw.type === 'pane') return parsePane(raw.pane, lookup)
  if (raw.type !== 'split' || !isRecord(raw.split)) return null
  const { orientation, dividerPosition } = raw.split
  if (orientation !== 'horizontal' && orientation !== 'vertical') return null
  const first = parseLayout(raw.split.first, lookup, depth + 1)
  const second = parseLayout(raw.split.second, lookup, depth + 1)
  if (!first || !second) return first ?? second
  const divider =
    typeof dividerPosition === 'number' && dividerPosition > 0 && dividerPosition < 1
      ? dividerPosition
      : 0.5
  return { type: 'split', direction: orientation, divider, first, second }
}

function panelsById(raw: unknown): Map<string, Record<string, unknown>> {
  const panels = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(raw)) return panels
  for (const panel of raw) {
    if (isRecord(panel) && typeof panel.id === 'string' && !panels.has(panel.id)) {
      panels.set(panel.id, panel)
    }
  }
  return panels
}

function parseWorkspace(raw: unknown, groups: Map<string, string>): CmuxWorkspace | null {
  if (!isRecord(raw)) return null
  const directory = absolutePath(raw.currentDirectory)
  if (!directory) return null
  const lookup: PanelLookup = {
    panels: panelsById(raw.panels),
    used: new Set(),
    focusedId: raw.focusedPanelId,
  }
  const layout: CmuxLayout = parseLayout(raw.layout, lookup, 0) ?? {
    type: 'pane',
    surfaces: [],
    selected: 0,
  }
  const workspace: CmuxWorkspace = { directory, layout }
  const title = text(raw.customTitle)
  if (title) workspace.title = title
  const description = text(raw.customDescription)
  if (description) workspace.description = description
  if (raw.isPinned === true) workspace.pinned = true
  const group = typeof raw.groupId === 'string' ? groups.get(raw.groupId) : undefined
  if (group) workspace.group = group
  if (isRecord(raw.remote)) workspace.remote = true
  if (raw.layoutMode === 'canvas') workspace.canvas = true
  return workspace
}

function groupNames(raw: unknown): Map<string, string> {
  const names = new Map<string, string>()
  if (!Array.isArray(raw)) return names
  for (const group of raw) {
    if (!isRecord(group) || typeof group.id !== 'string') continue
    const name = text(group.name)
    if (name) names.set(group.id, name)
  }
  return names
}

function parseWindow(raw: unknown): CmuxWindow | null {
  if (!isRecord(raw) || !isRecord(raw.tabManager)) return null
  const { workspaces, workspaceGroups } = raw.tabManager
  if (!Array.isArray(workspaces)) return null
  const groups = groupNames(workspaceGroups)
  const parsed: CmuxWorkspace[] = []
  for (const entry of workspaces) {
    const workspace = parseWorkspace(entry, groups)
    if (workspace) parsed.push(workspace)
  }
  return { workspaces: parsed }
}

export function parseCmuxSession(
  raw: unknown,
): { session: CmuxSession } | { error: 'invalid' | 'unsupported-version' } {
  if (!isRecord(raw)) return { error: 'invalid' }
  if (typeof raw.version === 'number' && raw.version !== CMUX_SESSION_VERSION) {
    return { error: 'unsupported-version' }
  }
  if (raw.version !== CMUX_SESSION_VERSION || !Array.isArray(raw.windows)) {
    return { error: 'invalid' }
  }
  const windows: CmuxWindow[] = []
  for (const entry of raw.windows) {
    const parsed = parseWindow(entry)
    if (parsed) windows.push(parsed)
  }
  return { session: { windows } }
}
