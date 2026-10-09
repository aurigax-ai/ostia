import { paneIds, splitOf } from '@/layout/tree'
import type { PaneNode, SurfaceKind } from '@/layout/types'
import { useUIStore } from '@/stores/app/uiStore'
import { useChatStore } from '@/stores/assist/chatStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useMergeConfirmStore } from '@/stores/workspaces/mergeConfirmStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { type WorkspaceSandbox, emptyWorkspaceSandbox } from '@shared/sandbox/sandbox'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadMergeTargets, requestMergeWorkspace } from './workspaceMerge'

const pane = (id: string, kind: SurfaceKind = 'terminal', title = 'zsh'): PaneNode => ({
  type: 'pane',
  id,
  title,
  kind,
})

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return { id, name: id, kind: 'terminal', workDir: '/home/u/proj', state: 'idle', ...over }
}

function sandboxes(byId: Record<string, WorkspaceSandbox>): void {
  vi.mocked(window.ostia.sandbox.get).mockImplementation(async (id) => byId[id] ?? null)
}

function seed(): void {
  useWindowsStore.setState({ windowId: 'win1', list: [] })
  useWorkspacesStore.setState({
    workspaces: [
      workspace('w1', { projectDir: '~/proj' }),
      workspace('w2', { name: 'proj', customName: 'side', workDir: '/home/u/proj/' }),
      workspace('w3', { workDir: '/home/u/other' }),
    ],
    activeWorkspaceId: 'w2',
  })
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: pane('p1'), activePaneId: 'p1', zoomedPaneId: null },
      w2: {
        root: splitOf(
          'horizontal',
          pane('p2', 'terminal', 'build'),
          pane('p3', 'editor', 'a.ts'),
          pane('p4', 'browser', 'localhost'),
          pane('p5', 'diff', 'Diff'),
        ),
        activePaneId: 'p2',
        zoomedPaneId: null,
      },
      w3: { root: pane('p6'), activePaneId: 'p6', zoomedPaneId: null },
    },
  })
  useBlocksStore.setState({
    running: { p2: 'b1' },
    byPane: { p2: [{ id: 'b1', paneId: 'p2', command: 'npm run dev' } as CommandBlock] },
  })
}

async function pendingSummary() {
  await vi.waitFor(() => expect(useMergeConfirmStore.getState().pending).not.toBeNull())
  return useMergeConfirmStore.getState().pending?.summary
}

describe('workspace merge', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let windowsInit: ReturnType<typeof useWindowsStore.getState>
  let chatInit: ReturnType<typeof useChatStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let confirmInit: ReturnType<typeof useMergeConfirmStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
    windowsInit = useWindowsStore.getState()
    chatInit = useChatStore.getState()
    uiInit = useUIStore.getState()
    confirmInit = useMergeConfirmStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    useWindowsStore.setState(windowsInit, true)
    useChatStore.setState(chatInit, true)
    useUIStore.setState(uiInit, true)
    useMergeConfirmStore.setState(confirmInit, true)
    vi.mocked(window.ostia.sandbox.get).mockResolvedValue(null)
    vi.mocked(window.ostia.workspace.merge).mockResolvedValue({ ok: true })
    vi.clearAllMocks()
  })

  describe('loadMergeTargets', () => {
    it('offers only workspaces in the same folder, by their shown name', async () => {
      seed()
      expect(await loadMergeTargets('w1')).toEqual([{ id: 'w2', name: 'side', refusal: null }])
      expect(await loadMergeTargets('w2')).toEqual([{ id: 'w1', name: 'w1', refusal: null }])
      expect(await loadMergeTargets('w3')).toEqual([])
    })

    it('lists a same-folder workspace of another window as refused', async () => {
      seed()
      useWindowsStore.setState({
        list: [
          {
            windowId: 'win2',
            detached: true,
            workspaces: [
              {
                id: 'r1',
                name: 'far',
                workDir: '/home/u/proj',
                state: 'idle',
                unreadAt: 0,
                panes: [],
              },
              { id: 'r2', name: 'away', workDir: '/srv', state: 'idle', unreadAt: 0, panes: [] },
            ],
          },
        ],
      })
      expect(await loadMergeTargets('w1')).toEqual([
        { id: 'w2', name: 'side', refusal: null },
        { id: 'r1', name: 'far', refusal: 'other-window' },
      ])
    })

    it('refuses a target whose sandbox differs from the source’s', async () => {
      seed()
      sandboxes({ w1: { ...emptyWorkspaceSandbox(), enabled: true } })
      expect(await loadMergeTargets('w1')).toEqual([
        { id: 'w2', name: 'side', refusal: 'sandbox-mixed' },
      ])
    })
  })

  describe('requestMergeWorkspace', () => {
    it('asks first and says what moves, then merges on Merge', async () => {
      seed()
      const done = requestMergeWorkspace('w2', 'w1')

      expect(await pendingSummary()).toEqual({
        source: 'side',
        target: 'w1',
        terminals: 1,
        editors: 1,
        browsers: 1,
        others: 1,
        running: [{ paneId: 'p2', title: 'build', command: 'npm run dev' }],
        chat: false,
        sandbox: false,
      })
      expect(window.ostia.workspace.merge).not.toHaveBeenCalled()

      useMergeConfirmStore.getState().answer(true)
      expect(await done).toBe(true)
      expect(window.ostia.workspace.merge).toHaveBeenCalledWith('w2', 'w1')
      expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['w1', 'w3'])
      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w1')
      const target = useLayoutStore.getState().byWorkspace.w1
      expect(paneIds(target.root).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
      expect(target.activePaneId).toBe('p2')
    })

    it('changes nothing when the human cancels', async () => {
      seed()
      const done = requestMergeWorkspace('w2', 'w1')
      await pendingSummary()
      useMergeConfirmStore.getState().answer(false)

      expect(await done).toBe(false)
      expect(window.ostia.workspace.merge).not.toHaveBeenCalled()
      expect(useWorkspacesStore.getState().workspaces).toHaveLength(3)
    })

    it('changes nothing when main refuses the merge', async () => {
      seed()
      vi.mocked(window.ostia.workspace.merge).mockResolvedValue({
        ok: false,
        error: 'sandbox-differs',
      })
      const done = requestMergeWorkspace('w2', 'w1')
      await pendingSummary()
      useMergeConfirmStore.getState().answer(true)

      expect(await done).toBe(false)
      expect(useWorkspacesStore.getState().workspaces).toHaveLength(3)
      expect(useLayoutStore.getState().byWorkspace.w2).toBeDefined()
    })

    it('never asks for a target in another folder', async () => {
      seed()
      expect(await requestMergeWorkspace('w2', 'w3')).toBe(false)
      expect(useMergeConfirmStore.getState().pending).toBeNull()
    })

    it('carries the source’s chat over when the target has none', async () => {
      seed()
      useChatStore.setState({
        current: { w2: 'c1' },
        meta: { c1: { id: 'c1', title: 'q', createdAt: 1, workspaceId: 'w2' } },
        drafts: { w2: 'half a question' },
      })
      const done = requestMergeWorkspace('w2', 'w1')
      expect((await pendingSummary())?.chat).toBe(false)
      useMergeConfirmStore.getState().answer(true)
      await done

      const chat = useChatStore.getState()
      expect(chat.current).toEqual({ w1: 'c1' })
      expect(chat.meta.c1.workspaceId).toBe('w1')
      expect(chat.drafts).toEqual({ w1: 'half a question' })
    })

    it('keeps the target’s chat and says so when both have one', async () => {
      seed()
      useChatStore.setState({ current: { w1: 'c0', w2: 'c1' } })
      const done = requestMergeWorkspace('w2', 'w1')
      expect((await pendingSummary())?.chat).toBe(true)
      useMergeConfirmStore.getState().answer(true)
      await done

      expect(useChatStore.getState().current).toEqual({ w1: 'c0' })
    })

    it('points open workspace settings of the source at the target', async () => {
      seed()
      useUIStore.getState().openWorkspaceSettings('w2')
      const done = requestMergeWorkspace('w2', 'w1')
      await pendingSummary()
      useMergeConfirmStore.getState().answer(true)
      await done

      expect(useUIStore.getState().settingsWorkspaceId).toBe('w1')
    })

    it('says sandbox allowances stay behind when two equal sandboxes merge', async () => {
      seed()
      const box = { ...emptyWorkspaceSandbox(), enabled: true, domains: ['a.dev'] }
      sandboxes({ w1: box, w2: { ...box } })
      const done = requestMergeWorkspace('w2', 'w1')
      expect((await pendingSummary())?.sandbox).toBe(true)
      useMergeConfirmStore.getState().answer(false)
      await done
    })
  })
})
