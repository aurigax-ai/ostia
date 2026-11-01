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

  it('leaves focus alone when a command opened a dialog, so Escape reaches that dialog', () => {
    releaseFocusForPalette()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-open', '')
    document.body.append(dialog)
    expect(paletteReturnFocus()).toBe(false)
  })

  it('still returns focus when the only dialog left is the closing palette', () => {
    releaseFocusForPalette()
    const closing = document.createElement('div')
    closing.setAttribute('role', 'dialog')
    closing.setAttribute('data-closed', '')
    document.body.append(closing)
    expect(paletteReturnFocus()).toBe(terminal)
  })
})
