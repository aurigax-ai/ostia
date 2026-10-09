import '@testing-library/jest-dom/vitest'
import { commands } from '@/commands/registry'
import { ActionConfirmDialog } from '@/components/settings/ActionConfirmDialog'
import { registerViewCommands } from '@/lib/extensions/views'
import { useActionConfirmStore } from '@/stores/agents/actionConfirmStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useViewsStore } from '@/stores/extensions/viewsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  VIEW_MAX_LIST_ITEMS,
  type ViewInfo,
  type ViewStatus,
  parseViewText,
} from '@shared/views/views'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ViewSurface } from './ViewSurface'
import { ViewsRail } from './ViewsRail'
import { ViewsSection } from './ViewsSection'

const SIDEBAR = {
  version: 1,
  title: 'My workspaces',
  placement: 'sidebar',
  icon: 'robot',
  root: {
    type: 'stack',
    children: [
      {
        type: 'list',
        for: 'workspaces',
        as: 'ws',
        item: {
          type: 'row',
          justify: 'between',
          children: [
            { type: 'text', text: '{{ws.name}}' },
            {
              type: 'button',
              label: 'Go {{ws.name}}',
              action: { command: 'test.view.goto', args: { index: '{{ws.index}}' } },
            },
          ],
        },
      },
      { type: 'button', label: 'Risky', action: { command: 'test.view.risky', args: { x: 1 } } },
    ],
  },
}

function info(
  name: string,
  raw: object,
  status: ViewStatus,
  extra: Partial<ViewInfo> = {},
): ViewInfo {
  const parsed = parseViewText(JSON.stringify(raw, null, 2))
  const doc = parsed.ok ? parsed.doc : null
  return {
    name,
    file: `/home/u/.config/ostia/views/${name}.json`,
    status,
    title: doc?.title ?? name,
    placement: doc?.placement ?? null,
    doc: status === 'enabled' ? doc : null,
    stale: false,
    problems: parsed.ok ? [] : parsed.problems,
    ...extra,
  }
}

function seedWorkspaces(names: string[]): void {
  const workspaces: Workspace[] = names.map((name, i) => ({
    id: `w${i + 1}`,
    name,
    kind: 'terminal',
    workDir: `/home/u/${name}`,
    state: 'idle',
  }))
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId: workspaces[0]?.id ?? null })
}

const goto = vi.fn()
const risky = vi.fn()

describe('declarative views', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let viewsInit: ReturnType<typeof useViewsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    viewsInit = useViewsStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    commands.register({ id: 'test.view.goto', title: 'Goto', run: (args) => goto(args) })
    commands.register({
      id: 'test.view.risky',
      title: 'Risky',
      capabilities: ['shell'],
      run: (args) => risky(args),
    })
    registerViewCommands()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useViewsStore.setState(viewsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    useActionConfirmStore.setState({ pending: null })
    goto.mockClear()
    risky.mockClear()
  })

  it('shows an enabled sidebar view with live workspace names', () => {
    seedWorkspaces(['alpha', 'beta'])
    useViewsStore.setState({ views: [info('agents', SIDEBAR, 'enabled')] })
    render(<ViewsRail />)
    const section = screen.getByRole('region', { name: 'My workspaces' })
    expect(within(section).getByText('alpha')).toBeInTheDocument()
    expect(within(section).getByText('beta')).toBeInTheDocument()
    act(() => useWorkspacesStore.getState().rename('w2', 'gamma'))
    expect(within(section).getByText('gamma')).toBeInTheDocument()
  })

  it('shows nothing for a view the human has not enabled', () => {
    seedWorkspaces(['alpha'])
    useViewsStore.setState({
      views: [info('agents', SIDEBAR, 'pending'), info('off', SIDEBAR, 'disabled')],
    })
    const { container } = render(<ViewsRail />)
    expect(container).toBeEmptyDOMElement()
  })

  it('collapses and expands a sidebar view', async () => {
    seedWorkspaces(['alpha'])
    useViewsStore.setState({ views: [info('agents', SIDEBAR, 'enabled')] })
    render(<ViewsRail />)
    await userEvent.click(screen.getByRole('button', { name: 'Collapse My workspaces' }))
    expect(screen.queryByText('alpha')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Expand My workspaces' }))
    expect(screen.getByText('alpha')).toBeInTheDocument()
  })

  it('runs a palette command with the row’s arguments when a button is clicked', async () => {
    seedWorkspaces(['alpha', 'beta'])
    useViewsStore.setState({ views: [info('agents', SIDEBAR, 'enabled')] })
    render(<ViewsRail />)
    await userEvent.click(screen.getByRole('button', { name: 'Go beta' }))
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith({ index: 1 }))
  })

  it('asks before running a command that needs extra permission', async () => {
    seedWorkspaces(['alpha'])
    useViewsStore.setState({ views: [info('agents', SIDEBAR, 'enabled')] })
    render(
      <>
        <ViewsRail />
        <ActionConfirmDialog />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Risky' }))
    expect(await screen.findByText(/comes from the view file agents\.json/)).toBeInTheDocument()
    expect(risky).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Run once' }))
    await vi.waitFor(() => expect(risky).toHaveBeenCalledWith({ x: 1 }))
  })

  it('keeps the last good render and says why when a list goes over budget', () => {
    seedWorkspaces(['alpha', 'beta'])
    useViewsStore.setState({ views: [info('agents', SIDEBAR, 'enabled')] })
    render(<ViewsRail />)
    act(() =>
      seedWorkspaces(Array.from({ length: VIEW_MAX_LIST_ITEMS + 1 }, (_, i) => `many-${i}`)),
    )
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('many-0')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      `root.children[0] has ${VIEW_MAX_LIST_ITEMS + 1} items`,
    )
  })

  it('opens a panel view as a pane through the views.open command', async () => {
    seedWorkspaces(['alpha'])
    const panel = { ...SIDEBAR, title: 'Board', placement: 'panel' }
    useViewsStore.setState({ views: [info('board', panel, 'enabled')] })
    const res = await commands.exec('views.open', { name: 'board' })
    expect(res.ok).toBe(true)
    const root = useLayoutStore.getState().byWorkspace.w1?.root
    expect(root).toMatchObject({ type: 'pane', kind: 'view', viewName: 'board', title: 'Board' })
    const refused = await commands.exec('views.open', { name: 'missing' })
    expect(refused.ok).toBe(false)
  })

  it('shows the way to Settings in a pane whose view is off', async () => {
    seedWorkspaces(['alpha'])
    useViewsStore.setState({
      views: [info('board', { ...SIDEBAR, placement: 'panel' }, 'disabled')],
    })
    render(<ViewSurface paneId="p1" workspaceId="w1" viewName="board" />)
    expect(screen.getByText(/This view is off/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(useUIStore.getState()).toMatchObject({ settingsActive: true, settingsSection: 'views' })
  })

  it('lists view files in Settings with their state, problems and an enable switch', async () => {
    const broken = { ...SIDEBAR, root: { type: 'text', text: '{{nope}}' } }
    useViewsStore.setState({
      dir: '/home/u/.config/ostia/views',
      views: [info('agents', SIDEBAR, 'pending'), info('broken', broken, 'disabled')],
    })
    vi.mocked(window.ostia.views.setEnabled).mockResolvedValue({
      dir: '/home/u/.config/ostia/views',
      views: [info('agents', SIDEBAR, 'enabled')],
    })
    render(<ViewsSection />)
    expect(screen.getByText(/\/home\/u\/\.config\/ostia\/views/)).toBeInTheDocument()
    const agents = screen.getByText('agents.json').closest('li') as HTMLElement
    expect(within(agents).getByText('New')).toBeInTheDocument()
    const row = screen.getByText('broken.json').closest('li') as HTMLElement
    expect(within(row).getByText('line 8')).toBeInTheDocument()
    expect(within(row).getByText(/unknown data source 'nope'/)).toBeInTheDocument()
    expect(within(row).getByRole('switch')).toHaveAttribute('data-disabled')

    await userEvent.click(within(agents).getByRole('switch', { name: 'Show My workspaces' }))
    expect(window.ostia.views.setEnabled).toHaveBeenCalledWith('agents', true)
    await vi.waitFor(() => expect(useViewsStore.getState().views[0].status).toBe('enabled'))

    await userEvent.click(within(agents).getByRole('button', { name: 'Reveal file' }))
    expect(window.ostia.views.reveal).toHaveBeenCalledWith('agents')
  })
})
