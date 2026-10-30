import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { type AgentResume, sameResume } from '@shared/agents/agentResume'
import { isArchivePath } from '@shared/archives/archivePaths'
import type { BrowserDevice } from '@shared/browser/browserDevice'
import { type BrowserProfile, parseBrowserProfile } from '@shared/browser/browserProfile'
import { isEqual } from 'es-toolkit'
import { baseName, parentOf } from '@/lib/files/fileTree'
import { allPanes, findPane } from './tree'
import type { LayoutNode, PaneNode, SurfaceKind, TabNode } from './types'

export function mapPanes(node: LayoutNode, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  if (node.type === 'pane') return fn(node)
  if (node.type === 'tabs') {
    const children = node.children.map((c) => mapPanes(c, fn) as TabNode)
    return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
  }
  const children = node.children.map((c) => mapPanes(c, fn))
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
}

function mapPane(root: LayoutNode, paneId: string, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  return mapPanes(root, (p) => (p.id === paneId ? fn(p) : p))
}

export function setResumePending(root: LayoutNode, paneId: string, pending: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.resumePending) === pending) return p
    if (pending) return { ...p, resumePending: true }
    const { resumePending: _pending, ...rest } = p
    return rest
  })
}

export function setPaneCwd(root: LayoutNode, paneId: string, cwd: string): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (p.resumeFolderMissing === cwd) {
      const { resumeFolderMissing: _missing, ...rest } = p
      return { ...rest, cwd }
    }
    return p.cwd === cwd ? p : { ...p, cwd }
  })
}

export function setPaneSpawnDir(root: LayoutNode, paneId: string, spawnDir: string): LayoutNode {
  return mapPane(root, paneId, (p) => (p.spawnDir === spawnDir ? p : { ...p, spawnDir }))
}

export function settleSpawnDir(root: LayoutNode, paneId: string, missing: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (p.spawnDir === undefined) return p
    const { spawnDir, ...rest } = p
    return missing ? { ...rest, resumeFolderMissing: spawnDir } : rest
  })
}

export function setPaneUrl(root: LayoutNode, paneId: string, url: string): LayoutNode {
  return mapPane(root, paneId, (p) => (p.url === url ? p : { ...p, url }))
}

function named(pane: PaneNode, title: string): PaneNode {
  const { defaultTitle: _default, ...rest } = pane
  return { ...rest, title }
}

export function setPaneTitle(root: LayoutNode, paneId: string, title: string): LayoutNode {
  return mapPane(root, paneId, (p) =>
    p.titlePinned || (p.title === title && !p.defaultTitle) ? p : named(p, title),
  )
}

export function renamePane(root: LayoutNode, paneId: string, title: string): LayoutNode {
  const name = title.trim()
  return mapPane(root, paneId, (p) => {
    if (name && p.title === name && p.titlePinned) return p
    if (name) return { ...named(p, name), titlePinned: true }
    if (!p.titlePinned) return p
    const { titlePinned: _pinned, ...rest } = p
    return rest
  })
}

function withDefaultTitle(pane: PaneNode, title: string): PaneNode {
  return pane.defaultTitle && pane.title !== title ? { ...pane, title } : pane
}

export function setDefaultPaneTitle(root: LayoutNode, paneId: string, title: string): LayoutNode {
  return mapPane(root, paneId, (p) => withDefaultTitle(p, title))
}

export function setDefaultPaneTitles(root: LayoutNode, title: string): LayoutNode {
  return mapPanes(root, (p) => withDefaultTitle(p, title))
}

export function setPaneResume(root: LayoutNode, paneId: string, resume: AgentResume): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (sameResume(p.resume, resume) && !p.resumeFailed) return p
    const { resumeFolderMissing: _missing, resumeFailed: _failed, ...rest } = p
    if (rest.resume?.agent === resume.agent) return { ...rest, resume }
    const { keepAwake: _kept, ...other } = rest
    return { ...other, resume }
  })
}

export function failPaneResume(
  root: LayoutNode,
  paneId: string,
  resume: AgentResume,
  exitCode: number,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (p.resume?.agent !== resume.agent || p.resume.id !== resume.id) return p
    const { resume: failed, resumePending: _pending, keepAwake: _kept, ...rest } = p
    return { ...rest, resumeFailed: { resume: failed, exitCode } }
  })
}

export function clearPaneResumeFailure(root: LayoutNode, paneId: string): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (!p.resumeFailed) return p
    const { resumeFailed: _failed, ...rest } = p
    return rest
  })
}

export function setPaneHibernated(
  root: LayoutNode,
  paneId: string,
  hibernated: boolean,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.hibernated) === hibernated) return p
    if (hibernated) {
      const { keepAwake: _kept, ...rest } = p
      return { ...rest, hibernated: true }
    }
    const { hibernated: _hibernated, ...awake } = p
    return awake.resume?.cwd ? { ...awake, spawnDir: awake.resume.cwd } : awake
  })
}

export function setPaneKeepAwake(root: LayoutNode, paneId: string, keepAwake: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.keepAwake) === keepAwake) return p
    if (keepAwake) return { ...p, keepAwake: true }
    const { keepAwake: _kept, ...awake } = p
    return awake
  })
}

export function setPaneLocked(root: LayoutNode, paneId: string, locked: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.locked) === locked) return p
    if (locked) return { ...p, locked: true }
    const { locked: _locked, ...open } = p
    return open
  })
}

export function hasLockedPane(root: LayoutNode): boolean {
  return allPanes(root).some((p) => p.locked === true)
}

export function firstPaneOfKind(node: LayoutNode, kind: SurfaceKind): PaneNode | null {
  return allPanes(node).find((p) => p.kind === kind) ?? null
}

export function setPaneEditor(
  root: LayoutNode,
  paneId: string,
  title: string,
  filePath: string,
): LayoutNode {
  if (isRemotePath(filePath) || isArchivePath(filePath)) {
    return mapPane(root, paneId, ({ cwd: _local, viewType: _viewType, ...p }) => ({
      ...p,
      kind: 'editor',
      title,
      filePath,
    }))
  }
  return mapPane(root, paneId, ({ viewType: _viewType, ...p }) => ({
    ...named(p, title),
    kind: 'editor',
    filePath,
    cwd: parentOf(filePath),
  }))
}

export function setPaneViewType(
  root: LayoutNode,
  paneId: string,
  viewType: string | null,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if ((p.viewType ?? null) === viewType) return p
    const { viewType: _previous, ...rest } = p
    return viewType === null ? rest : { ...rest, viewType }
  })
}

function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null
}

export function followMovedFile(root: LayoutNode, from: string, to: string): LayoutNode {
  return mapPanes(root, (p) => {
    if (p.kind !== 'editor' || !p.filePath) return p
    const next = movedPath(p.filePath, from, to)
    if (next === null) return p
    return setPaneEditor(p, p.id, baseName(next), next) as PaneNode
  })
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export function setPaneBrowser(
  root: LayoutNode,
  paneId: string,
  url: string,
  profile?: BrowserProfile,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    const next: PaneNode = { ...named(p, titleFromUrl(url)), kind: 'browser', url }
    if (profile === undefined) return next
    const { browserProfile: _previous, ...rest } = next
    return profile === 'shared' ? { ...rest, browserProfile: 'shared' } : rest
  })
}

export function setPaneBrowserDevice(
  root: LayoutNode,
  paneId: string,
  device: BrowserDevice | null,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (p.kind !== 'browser') return p
    const { browserDevice: previous, ...rest } = p
    if (!device) return previous ? rest : p
    return previous && isEqual(previous, device) ? p : { ...rest, browserDevice: device }
  })
}

export function paneBrowserProfile(pane: PaneNode): BrowserProfile {
  return parseBrowserProfile(pane.browserProfile)
}

export function browserPaneInUse(
  node: LayoutNode,
  activePaneId: string,
  profile: BrowserProfile,
): PaneNode | null {
  const isMatch = (p: PaneNode): boolean =>
    p.kind === 'browser' && paneBrowserProfile(p) === profile
  const active = findPane(node, activePaneId)
  if (active && isMatch(active)) return active
  return allPanes(node).find(isMatch) ?? null
}

export function setPaneChat(
  root: LayoutNode,
  paneId: string,
  title: string,
  sessionId?: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({
    type: 'pane',
    id: p.id,
    kind: 'chat',
    title,
    ...(sessionId ? { chatSessionId: sessionId } : {}),
  }))
}

export function setPaneAgent(
  root: LayoutNode,
  paneId: string,
  title: string,
  sessionId?: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({
    type: 'pane',
    id: p.id,
    kind: 'agent',
    title,
    ...(sessionId ? { agentSessionId: sessionId } : {}),
  }))
}

export function setPaneGit(root: LayoutNode, paneId: string, title: string): LayoutNode {
  return mapPane(root, paneId, (p) => ({ type: 'pane', id: p.id, kind: 'git', title }))
}

export function setPaneView(
  root: LayoutNode,
  paneId: string,
  viewName: string,
  title: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({ type: 'pane', id: p.id, kind: 'view', title, viewName }))
}

export function setPaneDiff(
  root: LayoutNode,
  paneId: string,
  title: string,
  cwd?: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({
    type: 'pane',
    id: p.id,
    kind: 'diff',
    title,
    ...(cwd ? { cwd } : {}),
  }))
}

export function isRemoteFilePane(pane: PaneNode): boolean {
  return pane.kind === 'editor' && isRemotePath(pane.filePath)
}

export function findViewPane(node: LayoutNode, viewName: string): PaneNode | null {
  return allPanes(node).find((p) => p.kind === 'view' && p.viewName === viewName) ?? null
}
