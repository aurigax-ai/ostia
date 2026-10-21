import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { releaseSurfaces, setFocusTarget, surfaceHost } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { registerBuiltinCommands } from './builtins'
import { type CommandContext, commands } from './registry'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  registerBuiltinCommands()
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  releaseSurfaces(new Set())
  document.body.replaceChildren()
})

function seed(): string {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 's1', name: 'project', kind: 'terminal', workDir: '/home/me/project', state: 'idle' },
    ],
    activeWorkspaceId: 's1',
  })
  useLayoutStore.getState().ensure('s1')
  return useLayoutStore.getState().byWorkspace.s1.activePaneId
}

function holdKeyboard(paneId: string): HTMLTextAreaElement {
  const input = document.createElement('textarea')
  surfaceHost(paneId).appendChild(input)
  document.body.appendChild(surfaceHost(paneId))
  setFocusTarget(paneId, () => input)
  input.focus()
  return input
}

function becomeReady(paneId: string): HTMLElement {
  const guest = document.createElement('div')
  guest.tabIndex = 0
  surfaceHost(paneId).appendChild(guest)
  document.body.appendChild(surfaceHost(paneId))
  setFocusTarget(paneId, () => guest)
  return guest
}

const context = (paneId: string, origin?: 'remote'): CommandContext => ({
  activeWorkspaceId: 's1',
  activePaneId: paneId,
  target: { workspaceId: 's1', paneId },
  origin,
})

describe('tab.newBrowser', () => {
  it('moves the keyboard into the new browser pane once its guest is ready', async () => {
    const first = seed()
    const input = holdKeyboard(first)
    await commands.execWith(context(first), 'tab.newBrowser', { paneId: first })
    const shown = useLayoutStore.getState().byWorkspace.s1.activePaneId
    expect(shown).not.toBe(first)
    expect(document.activeElement).toBe(input)
    const guest = becomeReady(shown)
    expect(document.activeElement).toBe(guest)
  })

  it('leaves the keyboard where it is when a socket caller asks', async () => {
    const first = seed()
    const input = holdKeyboard(first)
    await commands.execWith(context(first, 'remote'), 'tab.newBrowser', { paneId: first })
    const shown = useLayoutStore.getState().byWorkspace.s1.activePaneId
    becomeReady(shown)
    expect(document.activeElement).toBe(input)
  })
})
