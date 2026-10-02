import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPane, firstPaneId } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { commitProgramTitle, commitShellTitle } from './paneTitle'
import { pinTitle, resetPinnedTitles } from './pinnedTitles'

const WORKSPACE = 'w1'

function titleOf(paneId: string): string | undefined {
  return findPane(useLayoutStore.getState().byWorkspace[WORKSPACE].root, paneId)?.title
}

function newTerminal(): string {
  useLayoutStore.getState().ensure(WORKSPACE)
  return firstPaneId(useLayoutStore.getState().byWorkspace[WORKSPACE].root)
}

function openTitledTab(title: string): string {
  newTerminal()
  useWorkspacesStore.setState({
    workspaces: [{ id: WORKSPACE, name: 'proj', kind: 'terminal', workDir: '/srv', state: 'idle' }],
    activeWorkspaceId: WORKSPACE,
  })
  return useLayoutStore.getState().openTerminal(WORKSPACE, { title, backgroundTab: true }) as string
}

describe('terminal pane title', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    resetPinnedTitles()
  })

  it('shows the neutral word until the shell is known', () => {
    expect(titleOf(newTerminal())).toBe('Terminal')
  })

  it('names an untouched tab after the shell main spawned', () => {
    const paneId = newTerminal()
    commitShellTitle(WORKSPACE, paneId, 'bash')
    expect(titleOf(paneId)).toBe('bash')
  })

  it('follows the shell of a later spawn while the tab is still untouched', () => {
    const paneId = newTerminal()
    commitShellTitle(WORKSPACE, paneId, 'bash')
    commitShellTitle(WORKSPACE, paneId, 'zsh')
    expect(titleOf(paneId)).toBe('zsh')
  })

  it('keeps the neutral word when main reports no shell', () => {
    const paneId = newTerminal()
    commitShellTitle(WORKSPACE, paneId, undefined)
    commitShellTitle(WORKSPACE, paneId, '\u0007 ')
    expect(titleOf(paneId)).toBe('Terminal')
  })

  it('lets a title a program set win over the shell name, whichever came first', () => {
    const early = newTerminal()
    commitProgramTitle(WORKSPACE, early, '✳ Fix the build')
    commitShellTitle(WORKSPACE, early, 'bash')
    expect(titleOf(early)).toBe('✳ Fix the build')

    const late = openTitledTab('logs')
    useLayoutStore.getState().split(WORKSPACE, late, 'horizontal')
    const fresh = useLayoutStore.getState().byWorkspace[WORKSPACE].activePaneId
    commitShellTitle(WORKSPACE, fresh, 'bash')
    commitProgramTitle(WORKSPACE, fresh, 'user@host: ~')
    commitShellTitle(WORKSPACE, fresh, 'bash')
    expect(titleOf(fresh)).toBe('user@host: ~')
  })

  it('keeps the title a tab was opened with', () => {
    const paneId = openTitledTab('pnpm dev')
    commitShellTitle(WORKSPACE, paneId, 'bash')
    expect(titleOf(paneId)).toBe('pnpm dev')
  })

  it('keeps a pinned title against the shell name and against a program', () => {
    const named = openTitledTab('pnpm dev')
    pinTitle(named)
    commitShellTitle(WORKSPACE, named, 'bash')
    commitProgramTitle(WORKSPACE, named, 'vite')
    expect(titleOf(named)).toBe('pnpm dev')

    const untouched = firstPaneId(useLayoutStore.getState().byWorkspace[WORKSPACE].root)
    pinTitle(untouched)
    commitShellTitle(WORKSPACE, untouched, 'bash')
    expect(titleOf(untouched)).toBe('Terminal')
  })
})
