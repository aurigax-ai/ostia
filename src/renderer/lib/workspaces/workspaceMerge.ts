import { allPanes } from '@/layout/tree'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { chatReplacedByMerge, mergeChatWorkspace } from '@/stores/assist/chatStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { type MergeSummary, useMergeConfirmStore } from '@/stores/workspaces/mergeConfirmStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { WorkspaceSandbox } from '@shared/sandbox/sandbox'
import { runningCommandsOf } from './closeConfirm'
import {
  type MergeOption,
  type MergeSide,
  inferHome,
  mergeOptions,
  mergeRefusal,
} from './mergeEligibility'
import { remoteWorkspacesOf } from './windowWorkspaces'

export interface MergeTarget {
  id: string
  name: string
  refusal: MergeOption['refusal']
}

interface Evaluation {
  source: Workspace
  sourceSandbox: WorkspaceSandbox | null
  targets: MergeTarget[]
}

function nameOf(w: Pick<Workspace, 'name' | 'customName'>): string {
  return w.customName ?? w.name
}

async function sandboxOf(workspaceId: string): Promise<WorkspaceSandbox | null> {
  return (await window.ostia.sandbox?.get(workspaceId).catch(() => null)) ?? null
}

function sideOf(
  w: Workspace,
  windowId: string | null,
  sandbox: WorkspaceSandbox | null,
): MergeSide {
  return {
    id: w.id,
    kind: w.kind,
    workDir: w.workDir,
    ...(w.projectDir ? { projectDir: w.projectDir } : {}),
    windowId,
    sandbox,
  }
}

async function evaluate(sourceId: string): Promise<Evaluation | null> {
  const { workspaces } = useWorkspacesStore.getState()
  const source = workspaces.find((w) => w.id === sourceId)
  if (!source) return null
  const { windowId, list } = useWindowsStore.getState()
  const home = inferHome(workspaces)
  const plain = sideOf(source, windowId, null)
  const local = workspaces.filter((w) => {
    const refusal = mergeRefusal(plain, sideOf(w, windowId, null), home)
    return refusal !== 'self' && refusal !== 'manager' && refusal !== 'other-path'
  })
  const remote = remoteWorkspacesOf(list, windowId)
  const [sourceSandbox, ...sandboxes] = await Promise.all([
    sandboxOf(source.id),
    ...local.map((w) => sandboxOf(w.id)),
  ])
  const candidates = [
    ...local.map((w, i) => sideOf(w, windowId, sandboxes[i])),
    ...remote.map(
      (w): MergeSide => ({
        id: w.id,
        kind: 'terminal',
        workDir: w.workDir,
        windowId: w.windowId,
        sandbox: null,
      }),
    ),
  ]
  const names = new Map<string, string>([
    ...local.map((w): [string, string] => [w.id, nameOf(w)]),
    ...remote.map((w): [string, string] => [w.id, w.name]),
  ])
  const targets = mergeOptions(sideOf(source, windowId, sourceSandbox), candidates, home).map(
    (option) => ({
      id: option.targetId,
      name: names.get(option.targetId) ?? option.targetId,
      refusal: option.refusal,
    }),
  )
  return { source, sourceSandbox, targets }
}

export async function loadMergeTargets(sourceId: string): Promise<MergeTarget[]> {
  return (await evaluate(sourceId))?.targets ?? []
}

export function mergeSummary(source: Workspace, target: Workspace, sandbox: boolean): MergeSummary {
  const layout = useLayoutStore.getState().byWorkspace[source.id]
  const panes = layout ? allPanes(layout.root) : []
  const { running, byPane } = useBlocksStore.getState()
  const count = (kinds: readonly string[]): number =>
    panes.filter((p) => kinds.includes(p.kind)).length
  const terminals = panes.filter((p) => p.kind === 'terminal')
  return {
    source: nameOf(source),
    target: nameOf(target),
    terminals: terminals.length,
    editors: count(['editor']),
    browsers: count(['browser']),
    others: panes.length - count(['terminal', 'editor', 'browser']),
    running: terminals.flatMap((pane) =>
      runningCommandsOf([pane.id], running, byPane).map((command) => ({
        paneId: pane.id,
        title: pane.title,
        command,
      })),
    ),
    chat: chatReplacedByMerge(source.id, target.id),
    sandbox,
  }
}

function finishMerge(sourceId: string, targetId: string): void {
  mergeChatWorkspace(sourceId, targetId)
  useWorkspacesStore.getState().merge(sourceId, targetId)
  useSandboxStore.setState((s) => {
    const { [sourceId]: _merged, ...enabled } = s.enabled
    return { enabled }
  })
  const ui = useUIStore.getState()
  if (ui.settingsWorkspaceId === sourceId) useUIStore.setState({ settingsWorkspaceId: targetId })
  ui.showWorkspaces()
}

export async function requestMergeWorkspace(sourceId: string, targetId: string): Promise<boolean> {
  const evaluation = await evaluate(sourceId)
  const option = evaluation?.targets.find((t) => t.id === targetId)
  const target = useWorkspacesStore.getState().workspaces.find((w) => w.id === targetId)
  if (!evaluation || !option || option.refusal || !target) return false
  const summary = mergeSummary(
    evaluation.source,
    target,
    evaluation.sourceSandbox?.enabled ?? false,
  )
  if (!(await useMergeConfirmStore.getState().ask(summary))) return false
  const result = await window.ostia.workspace.merge(sourceId, targetId)
  if (!result.ok) return false
  finishMerge(sourceId, targetId)
  return true
}
