import '@testing-library/jest-dom/vitest'
import type { WorkspaceSandbox } from '@shared/sandbox'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import { SANDBOX_NAV_EXPANDED_KEY } from '../lib/settingsNav'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const SETTINGS: WorkspaceSandbox = { enabled: false, allowRead: [], domains: [], controls: {} }

function workspace(id: string, name: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, name, kind: 'terminal', workDir: `/home/u/${name}`, state: 'idle', ...extra }
}

function renderSettings(): void {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  render(<SettingsPanel />)
}

function nav(): HTMLElement {
  return screen.getByRole('navigation')
}

function disclosure(): HTMLElement {
  return within(nav()).getByRole('button', { name: 'Sandbox pages' })
}

function parent(): HTMLElement {
  return within(nav()).getByRole('button', { name: 'Sandbox' })
}

describe('SettingsPanel sandbox nav', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    installLocalStorage()
    vi.mocked(window.ostia.sandbox.get).mockResolvedValue(SETTINGS)
    useWorkspacesStore.setState({
      workspaces: [
        workspace('w1', 'terminal'),
        workspace('w2', 'api', { customName: 'Billing API' }),
        workspace('m', 'manager', { kind: 'manager' }),
      ],
    })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    useUIStore.setState(uiInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.restoreAllMocks()
  })

  it('nests the defaults and one entry per workspace under Sandbox, named without a prefix', async () => {
    renderSettings()
    const user = userEvent.setup()
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav()).queryByRole('button', { name: 'terminal' })).toBeNull()
    expect(within(nav()).queryByRole('button', { name: /Workspace:/ })).toBeNull()

    await user.click(disclosure())

    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    const list = within(nav()).getByRole('list', { name: 'Sandbox pages' })
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Defaults', 'terminal', 'Billing API'])
    expect(window.localStorage.getItem(SANDBOX_NAV_EXPANDED_KEY)).toBe('true')
  })

  it('opens a workspace page from its child and marks that child as the current page', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(disclosure())
    const list = within(nav()).getByRole('list', { name: 'Sandbox pages' })

    await user.click(within(list).getByRole('button', { name: 'Billing API' }))

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Workspace: Billing API' }),
    ).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Billing API' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(list).getByRole('button', { name: 'terminal' })).not.toHaveAttribute(
      'aria-current',
    )
    expect(parent()).not.toHaveAttribute('aria-current')
    expect(parent()).toHaveClass('text-fg')

    await user.click(within(list).getByRole('button', { name: 'Defaults' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Sandbox' })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Defaults' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('marks Sandbox itself as current while its children are folded away', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(parent())
    expect(parent()).toHaveAttribute('aria-current', 'page')
    await user.click(disclosure())
    expect(parent()).not.toHaveAttribute('aria-current')
  })

  it('unfolds to the workspace when its settings are asked for from the workspace menu', async () => {
    renderSettings()
    act(() => useUIStore.getState().openWorkspaceSettings('w1'))
    const list = await within(nav()).findByRole('list', { name: 'Sandbox pages' })
    expect(within(list).getByRole('button', { name: 'terminal' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Workspace: terminal' }),
    ).toBeInTheDocument()
  })

  it('unfolds with the right arrow, folds with the left, and returns focus to Sandbox from a child', async () => {
    renderSettings()
    const user = userEvent.setup()
    parent().focus()
    await user.keyboard('{ArrowRight}')
    const list = within(nav()).getByRole('list', { name: 'Sandbox pages' })
    const child = within(list).getByRole('button', { name: 'terminal' })
    child.focus()
    await user.keyboard('{ArrowLeft}')
    expect(parent()).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(within(nav()).queryByRole('list', { name: 'Sandbox pages' })).toBeNull()
  })

  it('finds a workspace by name when searching, without the fold control', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Search settings' }))
    await user.paste('billing')
    const list = within(nav()).getByRole('list', { name: 'Sandbox pages' })
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Billing API'])
    expect(within(nav()).queryByRole('button', { name: 'Sandbox pages' })).toBeNull()
  })
})
