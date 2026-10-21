import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { releaseSurfaces, setFocusTarget } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { hideRightPanel, RIGHT_PANEL_ID, rightFocusKey, toggleRightPanel } from './rightPanelFocus'

function focusable(parent: HTMLElement): HTMLElement {
  const el = document.createElement('button')
  parent.appendChild(el)
  return el
}

describe('right side panel focus', () => {
  let sideInit: ReturnType<typeof useSidePanelStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  const offs: Array<() => void> = []

  beforeAll(() => {
    sideInit = useSidePanelStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    for (const off of offs.splice(0)) off()
    releaseSurfaces(new Set())
    document.body.innerHTML = ''
    useSidePanelStore.setState(sideInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
  })

  function setup() {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'w1', kind: 'terminal', workDir: '/w1', state: 'idle' }],
      activeWorkspaceId: 'w1',
    })
    useLayoutStore.getState().ensure('w1')
    const paneId = useLayoutStore.getState().byWorkspace.w1.activePaneId
    const outside = focusable(document.body)
    offs.push(setFocusTarget(paneId, () => outside))
    const dock = document.createElement('aside')
    dock.id = RIGHT_PANEL_ID
    document.body.appendChild(dock)
    const inside = focusable(dock)
    offs.push(setFocusTarget(rightFocusKey('graphs', 'w1'), () => inside))
    return { outside, inside }
  }

  it('shows the panel and moves the keyboard into it when the human chooses it', () => {
    const { inside } = setup()
    toggleRightPanel('graphs')
    expect(useSidePanelStore.getState().right).toBe('graphs')
    expect(document.activeElement).toBe(inside)
  })

  it('hands the keyboard back to the active pane when the panel it was in is hidden', () => {
    const { outside, inside } = setup()
    toggleRightPanel('graphs')
    expect(document.activeElement).toBe(inside)

    toggleRightPanel('graphs')

    expect(useSidePanelStore.getState().right).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it('leaves the keyboard alone when the panel is hidden while it is elsewhere', () => {
    const { outside } = setup()
    useSidePanelStore.setState({ right: 'graphs' })
    outside.focus()

    hideRightPanel()

    expect(useSidePanelStore.getState().right).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it('does not move the keyboard when an extension reveals the panel', () => {
    const { outside } = setup()
    outside.focus()

    useSidePanelStore.getState().showRight('graphs', { workspaceId: 'w1' })

    expect(document.activeElement).toBe(outside)
  })
})
