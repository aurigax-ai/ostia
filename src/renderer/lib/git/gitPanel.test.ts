import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { firstPaneOfKind } from '@/lib/layout/paneFields'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useGitViewStore } from '@/stores/files/gitViewStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { GIT_PANEL_ID, openGit } from './gitPanel'

describe('openGit', () => {
  let sideInit: ReturnType<typeof useSidePanelStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let gitViewInit: ReturnType<typeof useGitViewStore.getState>

  beforeAll(() => {
    sideInit = useSidePanelStore.getState()
    layoutInit = useLayoutStore.getState()
    gitViewInit = useGitViewStore.getState()
  })

  afterEach(() => {
    useSidePanelStore.setState(sideInit, true)
    useLayoutStore.setState(layoutInit, true)
    useGitViewStore.setState(gitViewInit, true)
  })

  it('shows the Changes list in the right side panel and adds no pane', () => {
    useLayoutStore.getState().ensure('s1')
    const before = useLayoutStore.getState().byWorkspace.s1.root

    expect(openGit('s1', 'changes')).toBeNull()

    expect(useSidePanelStore.getState().right).toBe(GIT_PANEL_ID)
    expect(useLayoutStore.getState().byWorkspace.s1.root).toBe(before)
  })

  it('opens the commit graph and blame as a normal pane on that page', () => {
    useLayoutStore.getState().ensure('s1')

    const graph = openGit('s1', 'graph')
    const blame = openGit('s1', 'blame', '/repo/a.ts')

    const root = useLayoutStore.getState().byWorkspace.s1.root
    expect(firstPaneOfKind(root, 'git')?.id).toBe(graph)
    expect(blame).toBe(graph)
    expect(useGitViewStore.getState().nav[graph as string]).toMatchObject({
      page: 'blame',
      file: '/repo/a.ts',
    })
    expect(useSidePanelStore.getState().right).toBeNull()
  })
})
