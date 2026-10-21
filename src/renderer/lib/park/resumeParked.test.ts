import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPaneLayoutCommands } from '@/commands/core/paneLayoutCommands'
import { commands } from '@/commands/registry'
import * as resumeFolder from '@/lib/agents/resumeFolder'
import { allPanes } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useParkStore } from '@/stores/workspaces/parkStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { resumeParked } from './resumeParked'

const open: PaneNode = { type: 'pane', id: 'p1', kind: 'terminal', title: 'zsh' }
const resume = { agent: 'claude', id: 's1', cwd: '/home/u/api', args: ['--model', 'opus'] }

function seed(root: LayoutNode | null): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'alpha', kind: 'terminal', workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: root ? { w1: { root, activePaneId: 'p1', zoomedPaneId: null } } : {},
  })
}

const panesOf = (): PaneNode[] => {
  const layout = useLayoutStore.getState().byWorkspace.w1
  return layout ? allPanes(layout.root) : []
}

describe('resumeParked', () => {
  beforeEach(() => {
    if (!commands.has('tab.new')) registerPaneLayoutCommands()
    seed(open)
    useParkStore.setState({ notice: null })
  })
  afterEach(() => vi.restoreAllMocks())

  it('opens a new tab in the session’s folder and resumes there, asking about trust', async () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    expect(await resumeParked('w1', resume, '')).toBe(true)
    const fresh = panesOf().find((p) => p.id !== 'p1')
    expect(fresh).toMatchObject({ spawnDir: '/home/u/api' })
    expect(wait).toHaveBeenCalledTimes(1)
    const [paneId, token, , , , askTrust] = wait.mock.calls[0]
    expect(paneId).toBe(fresh?.id)
    expect(token).toEqual(resume)
    expect(askTrust).toBe(true)
  })

  it('names the tab only when it is given the human’s own name', async () => {
    vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    await resumeParked('w1', resume, '')
    const unnamed = panesOf().find((p) => p.id !== 'p1')
    expect(unnamed?.titlePinned).toBeUndefined()
    await resumeParked('w1', resume, 'export-tests')
    const named = panesOf().find((p) => p.title === 'export-tests')
    expect(named).toMatchObject({ titlePinned: true })
  })

  it('never types into the pane that was shown', async () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    await resumeParked('w1', resume, '')
    expect(wait.mock.calls[0][0]).not.toBe('p1')
  })

  it('opens the first pane of a workspace that has none, and resumes in it', async () => {
    seed(null)
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    expect(await resumeParked('w1', resume, '')).toBe(true)
    const panes = panesOf()
    expect(panes).toHaveLength(1)
    expect(panes[0]).toMatchObject({ kind: 'terminal', spawnDir: '/home/u/api' })
    expect(wait.mock.calls[0][0]).toBe(panes[0].id)
  })

  it.each([
    ['running-elsewhere', true, undefined],
    ['folder-missing', false, '/gone'],
    ['not-started', false, undefined],
  ] as const)(
    'keeps the tab and says why when the resume gave up: %s',
    async (reason, held, missing) => {
      const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
      vi.spyOn(resumeFolder, 'resumeFolderMissing').mockReturnValue(missing)
      await resumeParked('w1', resume, 'export-tests')
      const tab = wait.mock.calls[0][0]
      ;(wait.mock.calls[0][2] as (held: boolean) => void)(held)
      expect(panesOf().map((p) => p.id)).toContain(tab)
      expect(useParkStore.getState().notice).toMatchObject({
        kind: 'resumeFailed',
        paneId: tab,
        reason,
        title: 'export-tests',
      })
    },
  )

  it('opens nothing for a record with no folder or a bad token', async () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle')
    expect(await resumeParked('w1', { agent: 'claude', id: 's1' }, 't')).toBe(false)
    expect(await resumeParked('w1', { agent: 'zsh', id: 'x', cwd: '/a' }, 't')).toBe(false)
    expect(panesOf()).toHaveLength(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
