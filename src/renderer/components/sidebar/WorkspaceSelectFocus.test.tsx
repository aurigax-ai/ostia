import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { WorkZone } from '@/components/app/WorkZone'
import { CommandPalette } from '@/components/palette/CommandPalette'
import { startActivationResume } from '@/lib/agents/activationResume'
import { runAppChord } from '@/lib/keyboard/chords'
import { createPane, resetIds, splitOf, tabsOf } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import * as blockActions from '@/lib/terminal/blockActions'
import { activateWorkspace } from '@/lib/workspaces/windowHandoff'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { startRailEditSync, useRailEditStore } from '@/stores/workspaces/railEditStore'
import { releaseSurfaces, setFocusTarget, surfaceHost } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { renderSettled } from '../../../../test/render'
import { DeckRail } from './DeckRail'

vi.mock('allotment', async () => {
  const { forwardRef } = await import('react')
  const Allotment = forwardRef(function Allotment(
    { children }: { children?: ReactNode },
    _ref,
  ): JSX.Element {
    return <div>{children}</div>
  })
  const Pane = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return { Allotment: Object.assign(Allotment, { Pane }) }
})
vi.mock('@/components/panes/SurfacePool', () => ({ SurfacePool: () => null }))
vi.mock('@/components/settings/SettingsPanel', () => ({ SettingsPanel: () => null }))

const SWITCH_COMMANDS = new Set([
  'workspace.goto',
  'workspace.next',
  'workspace.previous',
  'view.goToWorkspace',
])

function workspace(id: string, name: string): Workspace {
  return { id, name, kind: 'terminal', workDir: `/${name}`, state: 'idle' }
}

const unregisters: (() => void)[] = []

function surfaceInput(paneId: string): HTMLTextAreaElement {
  const input = document.createElement('textarea')
  surfaceHost(paneId).appendChild(input)
  unregisters.push(setFocusTarget(paneId, () => (input.isConnected ? input : null)))
  return input
}

function layoutOf(workspaceId: string, root: LayoutNode, activePaneId: string): void {
  useLayoutStore.setState((s) => ({
    byWorkspace: { ...s.byWorkspace, [workspaceId]: { root, activePaneId, zoomedPaneId: null } },
  }))
}

interface Seeded {
  alpha: PaneNode
  beta: PaneNode
  inputs: Map<string, HTMLTextAreaElement>
}

function seed(betaRoot?: (beta: PaneNode) => LayoutNode, betaActive?: string): Seeded {
  useWorkspacesStore.setState({
    workspaces: [workspace('a', 'alpha'), workspace('b', 'beta'), workspace('c', 'empty')],
    activeWorkspaceId: 'a',
  })
  const alpha = createPane('terminal', 'alpha')
  const beta = createPane('terminal', 'beta')
  const root = betaRoot ? betaRoot(beta) : beta
  layoutOf('a', alpha, alpha.id)
  layoutOf('b', root, betaActive ?? beta.id)
  const inputs = new Map<string, HTMLTextAreaElement>()
  for (const pane of [alpha, ...panesOf(root)]) inputs.set(pane.id, surfaceInput(pane.id))
  return { alpha, beta, inputs }
}

function panesOf(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panesOf)
}

function input(seeded: Seeded, paneId: string): HTMLTextAreaElement {
  const found = seeded.inputs.get(paneId)
  if (!found) throw new Error(`no input for ${paneId}`)
  return found
}

async function renderApp(): Promise<void> {
  await renderSettled(
    <>
      <DeckRail />
      <WorkZone />
      <CommandPalette />
    </>,
  )
}

async function visitBetaAndReturn(seeded: Seeded): Promise<void> {
  act(() => useWorkspacesStore.getState().setActive('b'))
  act(() => useWorkspacesStore.getState().setActive('a'))
  act(() => input(seeded, seeded.alpha.id).focus())
  expect(input(seeded, seeded.alpha.id)).toHaveFocus()
}

function row(name: string): HTMLElement {
  const title = screen.getByText(name, { selector: '.tab-title' })
  const button = title.closest('button')
  if (!button) throw new Error(`no row for ${name}`)
  return button
}

function pressChord(init: KeyboardEventInit): void {
  act(() => {
    runAppChord(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }), false)
  })
}

describe('selecting a workspace gives the keyboard to its shown pane', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let stopSync: () => void = () => {}

  beforeAll(() => {
    if (!commands.has('workspace.goto')) registerBuiltinCommands()
    for (const { id } of commands.list()) {
      if (!SWITCH_COMMANDS.has(id)) commands.unregister(id)
    }
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
  })

  beforeEach(() => {
    resetIds()
    stopSync = startRailEditSync()
  })

  afterEach(() => {
    cleanup()
    stopSync()
    for (const unregister of unregisters.splice(0)) unregister()
    releaseSurfaces(new Set())
    vi.restoreAllMocks()
    useRailEditStore.setState({ editing: null, recollapse: false })
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
  })

  it('a click on a workspace row focuses its active pane', async () => {
    const seeded = seed()
    await renderApp()
    act(() => input(seeded, seeded.alpha.id).focus())

    await userEvent.setup().click(row('beta'))

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('b')
    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())
  })

  it('the jump chord and next/previous focus the active pane of the workspace they show', async () => {
    const seeded = seed()
    await renderApp()
    await visitBetaAndReturn(seeded)

    pressChord({ key: '2', code: 'Digit2', ctrlKey: true })
    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())

    await act(() => commands.exec('workspace.previous'))
    await waitFor(() => expect(input(seeded, seeded.alpha.id)).toHaveFocus())

    await act(() => commands.exec('workspace.next'))
    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())
  })

  it('a workspace picked in the palette takes the keyboard once the palette closes', async () => {
    const seeded = seed()
    await renderApp()
    await visitBetaAndReturn(seeded)
    const user = userEvent.setup()

    act(() => useUIStore.getState().openPalette('search', '@beta'))
    const option = await screen.findByRole('option', { name: /beta/ })
    await user.click(option)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())
  })

  it('in a split tab the pane that was last active takes the keyboard', async () => {
    const left = createPane('terminal', 'left')
    const right = createPane('terminal', 'right')
    const seeded = seed(
      (beta) => tabsOf(right.id, beta, splitOf('horizontal', left, right)),
      right.id,
    )
    await renderApp()

    await userEvent.setup().click(row('beta'))

    await waitFor(() => expect(input(seeded, right.id)).toHaveFocus())
  })

  it('an active pane no longer in the layout falls back to the top-left pane of the shown tab', async () => {
    const left = createPane('terminal', 'left')
    const right = createPane('terminal', 'right')
    const seeded = seed((beta) => tabsOf(right.id, beta, splitOf('vertical', left, right)), 'gone')
    await renderApp()

    await userEvent.setup().click(row('beta'))

    await waitFor(() => expect(input(seeded, left.id)).toHaveFocus())
  })

  it('a switch by a socket call or an extension never moves the keyboard', async () => {
    const seeded = seed()
    await renderApp()
    await visitBetaAndReturn(seeded)
    const remote = {
      activeWorkspaceId: 'a',
      activePaneId: seeded.alpha.id,
      target: { workspaceId: 'a', paneId: seeded.alpha.id },
      origin: 'remote' as const,
    }

    const nextFrame = () =>
      act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const alphaInput = input(seeded, seeded.alpha.id)

    await act(() => commands.execWith(remote, 'workspace.goto', { index: 1 }))
    await nextFrame()
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('b')
    expect(alphaInput).toHaveFocus()

    act(() => useWorkspacesStore.getState().setActive('a'))
    await act(() => commands.execWith(remote, 'workspace.next', undefined))
    await nextFrame()
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('b')
    expect(alphaInput).toHaveFocus()

    act(() => useWorkspacesStore.getState().setActive('a'))
    act(() => useWorkspacesStore.getState().setActive('b'))
    await nextFrame()
    expect(alphaInput).toHaveFocus()
  })

  it('a jump from another window takes the keyboard only when the human made it', async () => {
    const seeded = seed()
    await renderApp()
    await visitBetaAndReturn(seeded)

    act(() => activateWorkspace('b', false, false))
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('b')
    expect(input(seeded, seeded.alpha.id)).toHaveFocus()

    act(() => useWorkspacesStore.getState().setActive('a'))
    act(() => activateWorkspace('b', false, true))
    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())
  })

  it('a second selection before the first pane is ready wins, and the first never lands', async () => {
    const seeded = seed()
    const alphaInput = input(seeded, seeded.alpha.id)
    const betaInput = input(seeded, seeded.beta.id)
    betaInput.remove()
    await renderApp()
    act(() => useWorkspacesStore.getState().setActive('b'))
    act(() => useWorkspacesStore.getState().setActive('a'))
    act(() => row('alpha').focus())

    pressChord({ key: '2', code: 'Digit2', ctrlKey: true })
    pressChord({ key: '1', code: 'Digit1', ctrlKey: true })
    await waitFor(() => expect(alphaInput).toHaveFocus())
    act(() => {
      surfaceHost(seeded.beta.id).appendChild(betaInput)
    })
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

    expect(alphaInput).toHaveFocus()
  })

  it('a hibernated agent pane takes the keyboard without its resume being typed', async () => {
    const typed = vi.spyOn(blockActions, 'runWhenIdle')
    const stopActivation = startActivationResume()
    const seeded = seed()
    act(() => {
      useLayoutStore.getState().setHibernated('b', seeded.beta.id, true)
      useLayoutStore.setState((s) => {
        const layout = s.byWorkspace.b
        const root = layout.root.type === 'pane' ? layout.root : null
        if (!root) return s
        const pane = { ...root, resume: { agent: 'claude' as const, id: 'session-1' } }
        return { byWorkspace: { ...s.byWorkspace, b: { ...layout, root: pane } } }
      })
    })
    await renderApp()

    await userEvent.setup().click(row('beta'))

    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())
    const pane = useLayoutStore.getState().byWorkspace.b.root
    expect(pane.type === 'pane' && pane.hibernated).toBe(true)
    expect(typed).not.toHaveBeenCalled()
    stopActivation()
  })

  it('arrow keys in the sidebar keep the keyboard there and Enter commits the selection', async () => {
    const seeded = seed()
    await renderApp()
    const user = userEvent.setup()
    act(() => row('alpha').focus())

    await user.keyboard('{ArrowDown}{ArrowUp}{ArrowDown}')

    expect(document.activeElement?.closest('.rail-tab')).not.toBeNull()
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('a')

    act(() => row('beta').focus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(input(seeded, seeded.beta.id)).toHaveFocus())
  })

  it('renaming a workspace from its row keeps the keyboard in the rename field', async () => {
    const seeded = seed()
    input(seeded, seeded.beta.id).remove()
    await renderApp()

    await userEvent.setup().dblClick(row('beta'))
    const field = await screen.findByRole('textbox', { name: 'Workspace name' })
    await waitFor(() => expect(field).toHaveFocus())
    act(() => {
      surfaceInput(seeded.beta.id)
    })
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

    expect(field).toHaveFocus()
  })

  it('selecting the shown workspace leaves the keyboard where it is', async () => {
    const seeded = seed()
    await renderApp()
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    act(() => elsewhere.focus())

    pressChord({ key: '1', code: 'Digit1', ctrlKey: true })
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

    expect(elsewhere).toHaveFocus()
    expect(input(seeded, seeded.alpha.id)).not.toHaveFocus()
    elsewhere.remove()
  })

  it('a workspace with no panes takes nothing', async () => {
    const seeded = seed()
    await renderApp()
    act(() => input(seeded, seeded.alpha.id).focus())

    await userEvent.setup().click(row('empty'))

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('c')
    for (const element of seeded.inputs.values()) expect(element).not.toHaveFocus()
  })
})
