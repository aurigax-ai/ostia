import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as resumeFolder from '@/lib/agents/resumeFolder'
import { allPanes } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { resumeParked } from './resumeParked'

const open: PaneNode = { type: 'pane', id: 'p1', kind: 'terminal', title: 'zsh' }
const resume = { agent: 'claude', id: 's1', cwd: '/home/u/api', args: ['--model', 'opus'] }

function seed(root: LayoutNode | null): void {
  useLayoutStore.setState({
    byWorkspace: root ? { w1: { root, activePaneId: 'p1', zoomedPaneId: null } } : {},
  })
}

describe('resumeParked', () => {
  beforeEach(() => seed(open))
  afterEach(() => vi.restoreAllMocks())

  it('opens a new tab in the session’s folder with its title and resumes there, asking about trust', () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    expect(resumeParked('w1', resume, 'export-tests')).toBe(true)
    const panes = allPanes(useLayoutStore.getState().byWorkspace.w1.root)
    const fresh = panes.find((p) => p.id !== 'p1')
    expect(fresh).toMatchObject({ title: 'export-tests', spawnDir: '/home/u/api' })
    expect(wait).toHaveBeenCalledTimes(1)
    const [paneId, token, , , , askTrust] = wait.mock.calls[0]
    expect(paneId).toBe(fresh?.id)
    expect(token).toEqual(resume)
    expect(askTrust).toBe(true)
  })

  it('never types into the pane that was shown', () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    resumeParked('w1', resume, 'export-tests')
    expect(wait.mock.calls[0][0]).not.toBe('p1')
  })

  it('closes the new tab when the resume gave up', () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle').mockReturnValue(() => {})
    resumeParked('w1', resume, 'export-tests')
    const fresh = wait.mock.calls[0][0]
    ;(wait.mock.calls[0][2] as () => void)()
    expect(allPanes(useLayoutStore.getState().byWorkspace.w1.root).map((p) => p.id)).not.toContain(
      fresh,
    )
  })

  it('opens nothing for a record with no folder, a bad token or a pane-less workspace', () => {
    const wait = vi.spyOn(resumeFolder, 'resumeWhenIdle')
    expect(resumeParked('w1', { agent: 'claude', id: 's1' }, 't')).toBe(false)
    expect(resumeParked('w1', { agent: 'zsh', id: 'x', cwd: '/a' }, 't')).toBe(false)
    seed(null)
    expect(resumeParked('w1', resume, 't')).toBe(false)
    expect(wait).not.toHaveBeenCalled()
  })
})
