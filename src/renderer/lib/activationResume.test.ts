import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPane, tabsOf } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

vi.mock('./autoResume', () => ({ resumeOnActivation: vi.fn() }))

const { resumeOnActivation } = await import('./autoResume')
const { startActivationResume } = await import('./activationResume')

const front = createPane('terminal')
const back = createPane('terminal')
const other = createPane('terminal')

function seed(): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'one', kind: 'terminal', workDir: '/w', state: 'idle' },
      { id: 'w2', name: 'two', kind: 'terminal', workDir: '/w', state: 'idle' },
    ],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: tabsOf(front.id, front, back), activePaneId: front.id, zoomedPaneId: null },
      w2: { root: other, activePaneId: other.id, zoomedPaneId: null },
    },
  })
}

const focus = (paneId: string) => useLayoutStore.getState().focusPane('w1', paneId)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startActivationResume', () => {
  let stop: (() => void) | null = null
  const init = { layout: useLayoutStore.getState(), workspaces: useWorkspacesStore.getState() }

  beforeEach(() => {
    seed()
    stop = startActivationResume()
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.mocked(resumeOnActivation).mockClear()
    useLayoutStore.setState(init.layout, true)
    useWorkspacesStore.setState(init.workspaces, true)
  })

  it('resumes the pane the human clicks', () => {
    window.dispatchEvent(new MouseEvent('pointerdown'))
    focus(back.id)
    expect(resumeOnActivation).toHaveBeenCalledWith(back.id)
  })

  it('resumes the pane the human reaches with the keyboard or a tab switch', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    focus(back.id)
    expect(resumeOnActivation).toHaveBeenCalledWith(back.id)
  })

  it('resumes the shown pane of the workspace the human switches to', () => {
    window.dispatchEvent(new MouseEvent('click'))
    useWorkspacesStore.getState().setActive('w2')
    expect(resumeOnActivation).toHaveBeenCalledWith(other.id)
  })

  it('never resumes on focus moved by an agent, an extension or the socket', () => {
    focus(back.id)
    useWorkspacesStore.getState().setActive('w2')
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes on a focus change after the human input is handled', async () => {
    window.dispatchEvent(new MouseEvent('pointerdown'))
    await settle()
    focus(back.id)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes on pointer-over viewing', () => {
    window.dispatchEvent(new MouseEvent('mousemove'))
    window.dispatchEvent(new MouseEvent('pointerover'))
    focus(back.id)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes a background tab or the pane that is already active', () => {
    window.dispatchEvent(new MouseEvent('pointerdown'))
    const added = createPane('terminal')
    useLayoutStore.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        w1: { ...s.byWorkspace.w1, root: tabsOf(front.id, front, back, added) },
      },
    }))
    focus(front.id)
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })

  it('never resumes on restore at startup', () => {
    stop?.()
    useLayoutStore.setState(init.layout, true)
    useWorkspacesStore.setState(init.workspaces, true)
    stop = startActivationResume()
    seed()
    expect(resumeOnActivation).not.toHaveBeenCalled()
  })
})
