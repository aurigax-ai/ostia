import type { LifecycleEvent, SnapshotWorkspace, WindowSummary } from '@shared/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane, resetIds, splitPane } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useCloseConfirmStore } from '../stores/closeConfirmStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWindowsStore } from '../stores/windowsStore'
import { resetWorkspaceIds, useWorkspacesStore } from '../stores/workspacesStore'
import { setIdNamespace } from './idNamespace'
import {
  activateWorkspace,
  adoptWorkspaces,
  movePaneToNewWindow,
  moveWorkspaceToNewWindow,
  returnToMainWindow,
  workspaceSummaries,
} from './windowHandoff'
import { goToWorkspace, jumpToLatestUnread } from './workspaceActivity'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let windowsInit: ReturnType<typeof useWindowsStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let editorInit: ReturnType<typeof useEditorStatus.getState>
let confirmInit: ReturnType<typeof useCloseConfirmStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  windowsInit = useWindowsStore.getState()
  attentionInit = useAttentionStore.getState()
  editorInit = useEditorStatus.getState()
  confirmInit = useCloseConfirmStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useWindowsStore.setState(windowsInit, true)
  useAttentionStore.setState(attentionInit, true)
  useEditorStatus.setState(editorInit, true)
  useCloseConfirmStore.setState(confirmInit, true)
  resetIds()
  resetWorkspaceIds()
  setIdNamespace('')
})

function emitted(): LifecycleEvent[] {
  return vi.mocked(window.pine.lifecycle.emit).mock.calls.map(([event]) => event)
}

function seedTwoPanes(): { workspaceId: string; left: string; right: string } {
  useWorkspacesStore.getState().addWorkspace('/home/u/api')
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId as string
  useLayoutStore.getState().ensure(workspaceId)
  const left = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  useLayoutStore.getState().split(workspaceId, left, 'horizontal')
  const right = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  vi.mocked(window.pine.lifecycle.emit).mockClear()
  return { workspaceId, left, right }
}

describe('moveWorkspaceToNewWindow', () => {
  it('hands the workspace to main and releases it without closing its panes', async () => {
    const { workspaceId, left, right } = seedTwoPanes()

    expect(await moveWorkspaceToNewWindow(workspaceId)).toBe(true)

    const handoff = vi.mocked(window.pine.windows.detach).mock.calls[0][0]
    expect(handoff.id).toBe(workspaceId)
    expect(handoff.workDir).toBe('/home/u/api')
    expect(JSON.stringify(handoff.root)).toContain(left)
    expect(JSON.stringify(handoff.root)).toContain(right)
    expect(useWorkspacesStore.getState().workspaces).toEqual([])
    expect(useLayoutStore.getState().byWorkspace[workspaceId]).toBeUndefined()
    expect(
      emitted().filter((e) => e.type === 'pane-closed' || e.type === 'workspace-closed'),
    ).toEqual([])
  })

  it('keeps the workspace when main refuses the move', async () => {
    const { workspaceId } = seedTwoPanes()
    vi.mocked(window.pine.windows.detach).mockResolvedValueOnce(false)

    expect(await moveWorkspaceToNewWindow(workspaceId)).toBe(false)

    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual([workspaceId])
    expect(useLayoutStore.getState().byWorkspace[workspaceId]).toBeDefined()
  })

  it('carries a hibernated pane as hibernated so the new window never wakes it', async () => {
    const { workspaceId, left } = seedTwoPanes()
    useLayoutStore.getState().setResume(workspaceId, left, { agent: 'claude', id: 'abc' })
    useLayoutStore.getState().setHibernated(workspaceId, left, true)

    await moveWorkspaceToNewWindow(workspaceId)

    const handoff = vi.mocked(window.pine.windows.detach).mock.calls[0][0]
    expect(JSON.stringify(handoff.root)).toContain('"hibernated":true')
  })

  it('asks before moving unsaved files and stays put on cancel', async () => {
    const { workspaceId } = seedTwoPanes()
    useLayoutStore.getState().openFile(workspaceId, '/home/u/api/a.ts')
    useEditorStatus.getState().setDirty('/home/u/api/a.ts', true)

    const moving = moveWorkspaceToNewWindow(workspaceId)
    await vi.waitFor(() => expect(useCloseConfirmStore.getState().pending?.kind).toBe('move'))
    expect(useCloseConfirmStore.getState().pending?.groups[0].files).toEqual(['/home/u/api/a.ts'])
    useCloseConfirmStore.getState().answer(false)

    expect(await moving).toBe(false)
    expect(window.pine.windows.detach).not.toHaveBeenCalled()
  })
})

describe('movePaneToNewWindow', () => {
  it('moves one pane into a new workspace on the same folder and leaves the rest', async () => {
    const { workspaceId, left, right } = seedTwoPanes()

    expect(await movePaneToNewWindow(workspaceId, right)).toBe(true)

    const handoff = vi.mocked(window.pine.windows.detach).mock.calls[0][0]
    expect(handoff.id).not.toBe(workspaceId)
    expect(handoff.workDir).toBe('/home/u/api')
    expect(handoff.root).toMatchObject({ type: 'pane', id: right })
    const layout = useLayoutStore.getState().byWorkspace[workspaceId]
    expect(layout.root).toMatchObject({ type: 'pane', id: left })
    expect(emitted().some((e) => e.type === 'pane-closed')).toBe(false)
  })
})

describe('adoptWorkspaces', () => {
  const moved: SnapshotWorkspace = {
    id: 'wff00aa-4',
    name: 'web',
    kind: 'terminal',
    workDir: '/home/u/web',
    activePaneId: 'pane-9',
    root: {
      type: 'split',
      id: 'split-8',
      direction: 'horizontal',
      sizes: [1, 1],
      children: [
        { type: 'pane', id: 'pane-9', title: 'zsh', kind: 'terminal', cwd: '/home/u/web' },
        {
          type: 'pane',
          id: 'pane-10',
          title: 'claude',
          kind: 'terminal',
          resume: { agent: 'claude', id: 'abc' },
          hibernated: true,
        },
      ],
    },
  }

  it('keeps pane ids, activates the workspace and registers every pane with main', () => {
    adoptWorkspaces([moved])

    const state = useWorkspacesStore.getState()
    expect(state.workspaces.map((w) => w.id)).toEqual(['wff00aa-4'])
    expect(state.activeWorkspaceId).toBe('wff00aa-4')
    const layout = useLayoutStore.getState().byWorkspace['wff00aa-4']
    expect(layout.activePaneId).toBe('pane-9')
    expect(JSON.stringify(layout.root)).toContain('"hibernated":true')
    const created = emitted().filter((e) => e.type === 'pane-created')
    expect(created.map((e) => ('paneId' in e ? e.paneId : ''))).toEqual(['pane-9', 'pane-10'])
  })

  it('never mints a pane id that an adopted pane already holds', () => {
    adoptWorkspaces([moved])

    const fresh = createPane()
    expect(fresh.id).toBe('pane-11')
  })

  it('ignores a workspace this window already holds', () => {
    adoptWorkspaces([moved])
    adoptWorkspaces([moved])
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1)
  })
})

describe('id namespace', () => {
  it('mints ids another window cannot mint', () => {
    setIdNamespace('ab12cd')
    const pane = createPane()
    useWorkspacesStore.getState().addWorkspace('/tmp')
    expect(pane.id).toBe('pane-ab12cd-1')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('wab12cd-1')
    const { newPaneId } = splitPane(pane, pane.id, 'vertical')
    expect(newPaneId).toMatch(/^pane-ab12cd-\d+$/)
  })
})

describe('returnToMainWindow', () => {
  it('sends every workspace of the detached window back to main', async () => {
    const { workspaceId } = seedTwoPanes()

    expect(await returnToMainWindow()).toBe(true)

    const sent = vi.mocked(window.pine.windows.returnToMain).mock.calls[0][0]
    expect(sent.map((w) => w.id)).toEqual([workspaceId])
  })
})

describe('cross-window navigation', () => {
  const list = (unreadAt: number): WindowSummary[] => [
    { windowId: '1', detached: false, workspaces: [] },
    {
      windowId: '2',
      detached: true,
      workspaces: [
        { id: 'w-remote', name: 'web', workDir: '/w', state: 'idle', unreadAt, panes: [] },
      ],
    },
  ]

  it('Ctrl+N past the local workspaces focuses the window that owns the workspace', () => {
    useWorkspacesStore.getState().addWorkspace('/a')
    useWindowsStore.getState().setInfo('1', false)
    useWindowsStore.getState().setList(list(0))

    expect(goToWorkspace(1)).toBe(true)

    expect(window.pine.windows.focusWorkspace).toHaveBeenCalledWith('w-remote', false)
  })

  it('jump to latest unread goes to another window when its unread is newer', () => {
    useWindowsStore.getState().setInfo('1', false)
    useWindowsStore.getState().setList(list(5000))

    expect(jumpToLatestUnread()).toBeNull()

    expect(window.pine.windows.focusWorkspace).toHaveBeenCalledWith('w-remote', true)
  })

  it('activating a workspace from main selects it here', () => {
    useWorkspacesStore.getState().addWorkspace('/a')
    useWorkspacesStore.getState().addWorkspace('/b')
    const first = useWorkspacesStore.getState().workspaces[0].id

    activateWorkspace(first, false)

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(first)
  })

  it('reports each workspace with its display name and latest unread time', () => {
    const { workspaceId, left } = seedTwoPanes()
    useWorkspacesStore.getState().rename(workspaceId, 'API')
    useAttentionStore
      .getState()
      .dispatch(left, { type: 'notify', message: 'hi', waiting: false, at: 42 })

    const [summary] = workspaceSummaries()

    expect(summary).toMatchObject({ id: workspaceId, name: 'API', unreadAt: 42 })
    expect(summary.panes.map((p) => p.id)).toContain(left)
  })
})
