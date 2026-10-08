import type {
  CmuxImportReport,
  CmuxLayout,
  CmuxLoss,
  CmuxLossEntry,
  CmuxPaneLayout,
  CmuxSession,
  CmuxSessionError,
  CmuxSkippedEntry,
  CmuxSurface,
  CmuxWorkspace,
} from '@shared/cmuxSession'
import type { SnapshotWorkspace } from '@shared/types'
import { MAX_LAYOUT_DEPTH, MAX_PANES, MAX_WORKSPACES } from '@shared/workspaceLimits'
import { normalizeDescription } from '@shared/workspaceText'
import { type RestorableWorkspace, workspaceHandoff } from '../layout/snapshot'
import {
  TERMINAL_TITLE,
  createPane,
  createTerminalPane,
  firstPaneId,
  paneIds,
  splitOf,
  tabsOf,
} from '../layout/tree'
import type { LayoutNode, PaneNode } from '../layout/types'
import { useCmuxImportStore } from '../stores/cmuxImportStore'
import { isRestorable } from '../stores/persistence'
import { useSandboxStore } from '../stores/sandboxStore'
import { useWindowsStore } from '../stores/windowsStore'
import { nameFromWorkDir, nextWorkspaceId, useWorkspacesStore } from '../stores/workspacesStore'

const NAME_MAX = 120
const FLATTEN_DEPTH = MAX_LAYOUT_DEPTH - 1

export interface ExistingWorkspace {
  name: string
  workDir: string
  saved: boolean
}

export interface PlannedWorkspace {
  workspace: SnapshotWorkspace
  name: string
  window: number
  panes: number
  pinned?: true
  group?: string
  losses: CmuxLossEntry[]
}

export interface CmuxImportPlan {
  windows: PlannedWorkspace[][]
  skipped: CmuxSkippedEntry[]
}

export interface CmuxPlanOptions {
  existing: readonly ExistingWorkspace[]
  groups: boolean
}

interface Build {
  workspace: string
  directory: string
  losses: CmuxLossEntry[]
  panes: number
  dropped: number
  focusedId?: string
}

const ERROR_TEXT: Record<CmuxSessionError, string> = {
  'bad-path': 'the session file must be given as an absolute path',
  'outside-home': 'the session file must be inside your home folder',
  'not-found': 'no cmux session file there',
  unreadable: 'the cmux session file could not be read',
  'too-large': 'the cmux session file is larger than 32 MB',
  invalid: 'not a cmux session file',
  'unsupported-version':
    'the cmux session file was saved by a cmux version this import cannot read',
}

export class CmuxImportError extends Error {
  constructor(
    readonly code: CmuxSessionError,
    readonly path?: string,
  ) {
    super(path ? `${code}: ${ERROR_TEXT[code]} (${path})` : `${code}: ${ERROR_TEXT[code]}`)
  }
}

function trimDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir
}

function keyOf(name: string, workDir: string): string {
  return JSON.stringify([name, trimDir(workDir)])
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : '/'
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function customNameOf(workspace: CmuxWorkspace): string | undefined {
  return workspace.title?.slice(0, NAME_MAX)
}

function displayName(workspace: CmuxWorkspace): string {
  return customNameOf(workspace) ?? nameFromWorkDir(workspace.directory)
}

function surfaceLabel(surface: CmuxSurface): string {
  if (surface.title) return surface.title
  if (surface.filePath) return basename(surface.filePath)
  if (surface.url) return hostOf(surface.url)
  return surface.type === 'terminal' ? TERMINAL_TITLE : surface.type
}

function lose(build: Build, surface: CmuxSurface, loss: CmuxLoss, detail?: string): void {
  build.losses.push({
    workspace: build.workspace,
    pane: surfaceLabel(surface),
    loss,
    ...(detail ? { detail } : {}),
  })
}

function terminalPane(surface: CmuxSurface, build: Build): PaneNode {
  const cwd = surface.remote ? build.directory : (surface.directory ?? build.directory)
  const base = surface.title
    ? { ...createPane('terminal', surface.title, cwd), titlePinned: true as const }
    : createTerminalPane(TERMINAL_TITLE, cwd)
  if (surface.resume) lose(build, surface, 'agent-resume', surface.agent)
  else if (surface.agent) lose(build, surface, 'agent', surface.agent)
  if (surface.scrollback) lose(build, surface, 'scrollback')
  if (surface.remote) lose(build, surface, 'remote')
  return surface.resume ? { ...base, resume: surface.resume } : base
}

function browserPane(surface: CmuxSurface, build: Build): PaneNode {
  if (surface.browserHistory) lose(build, surface, 'browser-history')
  const url = surface.url
  if (!url) return createPane('browser', surface.title)
  return { ...createPane('browser', surface.title ?? hostOf(url)), url }
}

function editorPane(filePath: string, surface: CmuxSurface): PaneNode {
  const title = surface.title ?? basename(filePath)
  return { ...createPane('editor', title, parentDir(filePath)), filePath }
}

function importable(surface: CmuxSurface): boolean {
  if (surface.type === 'terminal' || surface.type === 'browser') return true
  return (surface.type === 'markdown' || surface.type === 'filepreview') && !!surface.filePath
}

function surfacePane(surface: CmuxSurface, build: Build): PaneNode | null {
  if (!importable(surface)) {
    lose(build, surface, 'surface', surface.type)
    return null
  }
  if (build.panes >= MAX_PANES) {
    build.dropped += 1
    return null
  }
  const pane =
    surface.type === 'terminal'
      ? terminalPane(surface, build)
      : surface.type === 'browser'
        ? browserPane(surface, build)
        : editorPane(surface.filePath as string, surface)
  build.panes += 1
  if (surface.focused) build.focusedId = pane.id
  return pane
}

function paneNode(layout: CmuxPaneLayout, build: Build): LayoutNode | null {
  const panes: PaneNode[] = []
  let activeId: string | undefined
  for (const [index, surface] of layout.surfaces.entries()) {
    const pane = surfacePane(surface, build)
    if (!pane) continue
    panes.push(pane)
    if (index === layout.selected) activeId = pane.id
  }
  if (panes.length === 0) return null
  if (panes.length === 1) return panes[0]
  return tabsOf(activeId ?? panes[0].id, ...panes)
}

function flatten(layout: CmuxLayout): CmuxPaneLayout {
  if (layout.type === 'pane') return layout
  const first = flatten(layout.first)
  const second = flatten(layout.second)
  return {
    type: 'pane',
    surfaces: [...first.surfaces, ...second.surfaces],
    selected: first.selected,
  }
}

function layoutNode(layout: CmuxLayout, depth: number, build: Build): LayoutNode | null {
  if (layout.type === 'pane') return paneNode(layout, build)
  if (depth >= FLATTEN_DEPTH) {
    build.losses.push({ workspace: build.workspace, loss: 'layout' })
    return paneNode(flatten(layout), build)
  }
  const first = layoutNode(layout.first, depth + 1, build)
  const second = layoutNode(layout.second, depth + 1, build)
  if (!first || !second) return first ?? second
  return {
    ...splitOf(layout.direction, first, second),
    sizes: [layout.divider, 1 - layout.divider],
  }
}

function planWorkspace(cmux: CmuxWorkspace, name: string, windowIndex: number): PlannedWorkspace {
  const build: Build = {
    workspace: name,
    directory: cmux.directory,
    losses: [],
    panes: 0,
    dropped: 0,
  }
  const root =
    layoutNode(cmux.layout, 0, build) ?? createTerminalPane(TERMINAL_TITLE, cmux.directory)
  if (build.dropped > 0) {
    build.losses.push({ workspace: name, loss: 'panes', detail: String(build.dropped) })
  }
  if (cmux.canvas) build.losses.push({ workspace: name, loss: 'canvas' })
  if (cmux.remote) build.losses.push({ workspace: name, loss: 'remote' })
  const customName = customNameOf(cmux)
  const description = normalizeDescription(cmux.description)
  const restorable: RestorableWorkspace = {
    id: nextWorkspaceId(),
    name: nameFromWorkDir(cmux.directory),
    ...(customName ? { customName } : {}),
    ...(description ? { description } : {}),
    kind: 'terminal',
    workDir: cmux.directory,
  }
  const activePaneId = build.focusedId ?? firstPaneId(root)
  return {
    workspace: workspaceHandoff(restorable, { root, activePaneId }, new Set()),
    name,
    window: windowIndex,
    panes: paneIds(root).length,
    ...(cmux.pinned ? { pinned: true as const } : {}),
    losses: build.losses,
  }
}

export function planCmuxImport(session: CmuxSession, options: CmuxPlanOptions): CmuxImportPlan {
  const remaining = new Map<string, number>()
  for (const w of options.existing) {
    const key = keyOf(w.name, w.workDir)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  let room = MAX_WORKSPACES - options.existing.filter((w) => w.saved).length
  const skipped: CmuxSkippedEntry[] = []
  const windows = session.windows.map((cmuxWindow, windowIndex) => {
    const planned: PlannedWorkspace[] = []
    for (const cmux of cmuxWindow.workspaces) {
      const name = displayName(cmux)
      const key = keyOf(name, cmux.directory)
      const left = remaining.get(key) ?? 0
      if (left > 0) {
        remaining.set(key, left - 1)
        skipped.push({ name, reason: 'exists', window: windowIndex })
        continue
      }
      if (room <= 0) {
        skipped.push({ name, reason: 'limit', window: windowIndex })
        continue
      }
      room -= 1
      const entry = planWorkspace(cmux, name, windowIndex)
      const keepsGroup = options.groups && windowIndex === 0 && !cmux.pinned
      if (cmux.group && keepsGroup) {
        entry.group = cmux.group
      } else if (cmux.group) {
        entry.losses.push({ workspace: name, loss: 'group', detail: cmux.group })
      }
      planned.push(entry)
    }
    return planned
  })
  return { windows, skipped }
}

function existingWorkspaces(): ExistingWorkspace[] {
  const byId = new Map<string, ExistingWorkspace>()
  for (const win of useWindowsStore.getState().list) {
    for (const w of win.workspaces) {
      byId.set(w.id, { name: w.name, workDir: w.workDir, saved: true })
    }
  }
  for (const w of useWorkspacesStore.getState().workspaces) {
    byId.set(w.id, { name: w.customName ?? w.name, workDir: w.workDir, saved: isRestorable(w) })
  }
  return [...byId.values()]
}

function record(report: CmuxImportReport, planned: readonly PlannedWorkspace[]): void {
  for (const p of planned) {
    report.imported.push({
      workspaceId: p.workspace.id,
      name: p.name,
      panes: p.panes,
      window: p.window,
    })
    report.notCarried.push(...p.losses)
  }
}

function adoptHere(planned: readonly PlannedWorkspace[]): void {
  useWorkspacesStore.getState().adopt(planned.map((p) => p.workspace))
  for (const p of planned) {
    const store = useWorkspacesStore.getState()
    if (p.pinned) store.setPinned(p.workspace.id, true)
    else if (p.group) store.moveToGroupNamed(p.workspace.id, p.group)
  }
  useWorkspacesStore.getState().setActive(planned[0].workspace.id)
}

function forNewWindow(planned: readonly PlannedWorkspace[]): SnapshotWorkspace[] {
  const pinned = planned.filter((p) => p.pinned).map((p) => ({ ...p.workspace, pinned: true }))
  const rest = planned.filter((p) => !p.pinned).map((p) => p.workspace)
  return [...pinned, ...rest]
}

async function importCmuxSession(path?: string): Promise<CmuxImportReport> {
  const read = await window.ostia.workspace.readCmux(path)
  if (!read.ok) throw new CmuxImportError(read.error, read.path)
  const plan = planCmuxImport(read.session, {
    existing: existingWorkspaces(),
    groups: !useWindowsStore.getState().detached,
  })
  const report: CmuxImportReport = {
    path: read.path,
    imported: [],
    skipped: [...plan.skipped],
    notCarried: [],
  }
  const [here = [], ...elsewhere] = plan.windows
  if (here.length > 0) {
    adoptHere(here)
    record(report, here)
  }
  for (const planned of elsewhere) {
    if (planned.length === 0) continue
    if (await window.ostia.windows.openWith(forNewWindow(planned))) {
      record(report, planned)
      continue
    }
    for (const p of planned) {
      report.skipped.push({ name: p.name, reason: 'window', window: p.window })
    }
  }
  return report
}

export interface CmuxImportRequest {
  path?: string
  callerWorkspaceId: string | null
  remote: boolean
}

export async function runCmuxImport(request: CmuxImportRequest): Promise<CmuxImportReport> {
  const caller = request.callerWorkspaceId
  if (request.remote && caller && useSandboxStore.getState().enabled[caller]) {
    throw new Error('sandboxed: a sandboxed workspace cannot import workspaces')
  }
  try {
    const report = await importCmuxSession(request.path)
    if (!request.remote) useCmuxImportStore.getState().show({ report })
    return report
  } catch (err) {
    if (!request.remote) {
      useCmuxImportStore
        .getState()
        .show(
          err instanceof CmuxImportError
            ? { error: err.code, ...(err.path ? { path: err.path } : {}) }
            : { error: 'unreadable' },
        )
    }
    throw err
  }
}
