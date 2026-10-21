import { beforeEach, describe, expect, it } from 'vitest'
import { newTerminalPane } from '@/stores/workspaces/layoutSeed'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { paletteReturnFocus, releaseFocusForPalette } from './paletteFocus'

describe('paletteReturnFocus', () => {
  let terminal: HTMLTextAreaElement
  const first = newTerminalPane()
  const second = newTerminalPane()

  beforeEach(() => {
    document.body.innerHTML = ''
    terminal = document.createElement('textarea')
    document.body.append(terminal)
    terminal.focus()
    useWorkspacesStore.setState({ activeWorkspaceId: 'w' })
    useLayoutStore.setState({
      byWorkspace: { w: { root: first, activePaneId: first.id, zoomedPaneId: null } },
    })
  })

  it('returns focus to the element the palette took it from', () => {
    releaseFocusForPalette()
    expect(paletteReturnFocus()).toBe(terminal)
  })

  it('leaves focus alone when a command made another pane the active one', () => {
    releaseFocusForPalette()
    useLayoutStore.setState({
      byWorkspace: { w: { root: second, activePaneId: second.id, zoomedPaneId: null } },
    })
    expect(paletteReturnFocus()).toBe(false)
  })
})
