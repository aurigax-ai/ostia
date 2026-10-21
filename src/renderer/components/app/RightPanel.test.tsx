import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetCoreWatch, watchedWorkspaces } from '@/lib/workspaces/coreWatch'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useInboxStore } from '@/stores/extensions/inboxStore'
import { usePanelToolbarStore } from '@/stores/extensions/panelToolbarStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'
import { RightPanel } from './RightPanel'

const panelInfo = (id: string, title: string, enabled = true): ExtensionInfo =>
  ({ id, name: title, enabled, assist: [], panel: { title } }) as unknown as ExtensionInfo

const toolbarInfo = (): ExtensionInfo =>
  ({
    ...panelInfo('trellis', 'Trellis'),
    panel: {
      title: 'Trellis',
      toolbar: {
        tabs: [
          { id: 'board', title: 'Board' },
          { id: 'vault', title: 'Vault' },
        ],
        actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh' }],
      },
    },
  }) as unknown as ExtensionInfo

const inboxInfo = (builtin: boolean): ExtensionInfo =>
  ({
    ...panelInfo('activity', 'Activity'),
    builtin,
    panel: {
      title: 'Activity',
      toolbar: {
        tabs: [
          { id: 'inbox', title: 'Inbox', surface: 'inbox' },
          { id: 'recap', title: 'Recap' },
        ],
        actions: [],
      },
    },
  }) as unknown as ExtensionInfo

const PANELS = [
  panelInfo('graphs', 'Graphs'),
  panelInfo('activity', 'Activity'),
  panelInfo('trellis', 'Trellis'),
  panelInfo('keeper', 'Keeper'),
]

const workspace = (id: string) => ({
  id,
  name: id,
  kind: 'terminal' as const,
  workDir: `/${id}`,
  state: 'idle' as const,
})

const dock = () => document.querySelector('#right-panel') as HTMLElement
const webviews = () => [...document.querySelectorAll<HTMLElement>('#right-panel webview')]
const show = (id: string, options?: { workspaceId?: string; path?: string }) =>
  act(() => useSidePanelStore.getState().showRight(id, options))

describe('RightPanel', () => {
  let sideInit: ReturnType<typeof useSidePanelStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let sandboxInit: ReturnType<typeof useSandboxStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  const panel = vi.fn()

  beforeAll(() => {
    sideInit = useSidePanelStore.getState()
    extInit = useExtensionsStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    sandboxInit = useSandboxStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  const setup = () => {
    installLocalStorage()
    panel.mockImplementation(async (extId: string, context: { workspaceId: string }) => ({
      ok: true as const,
      src: `http://127.0.0.1:4100/${extId}/${context.workspaceId}`,
    }))
    window.ostia.extensions.panel = panel
    useExtensionsStore.setState({ list: PANELS })
    useWorkspacesStore.setState({
      workspaces: [workspace('w1'), workspace('w2')],
      activeWorkspaceId: 'w1',
    })
  }

  afterEach(() => {
    cleanup()
    resetCoreWatch()
    panel.mockReset()
    useSidePanelStore.setState(sideInit, true)
    usePanelToolbarStore.setState({ entries: [] })
    useInboxStore.setState({ entries: [] })
    useApprovalsStore.setState({ pending: [] })
    useExtensionsStore.setState(extInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useSandboxStore.setState(sandboxInit, true)
    useSettingsStore.setState(settingsInit, true)
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--right-w')
  })

  it('is in the document but closed, with no webview, until a panel is shown', () => {
    setup()
    render(<RightPanel />)
    expect(dock()).toHaveAttribute('data-hidden')
    expect(dock().inert).toBe(true)
    expect(webviews()).toHaveLength(0)
    expect(panel).not.toHaveBeenCalled()
  })

  it('shows the panel of the active workspace in the extension partition and names itself after it', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')

    await waitFor(() => expect(webviews()).toHaveLength(1))
    expect(webviews()[0].getAttribute('partition')).toBe('ostia-ext-graphs')
    expect(webviews()[0].getAttribute('src')).toBe('http://127.0.0.1:4100/graphs/w1')
    expect(panel).toHaveBeenCalledWith('graphs', { workspaceId: 'w1', locale: 'en' })
    expect(dock()).not.toHaveAttribute('data-hidden')
    expect(dock().inert).toBe(false)
    expect(screen.getByRole('complementary', { name: 'Graphs' })).toBe(dock())
  })

  const hiddenByPartition = () =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('.right-panel-slot')].map((slot) => [
        slot.querySelector('webview')?.getAttribute('partition'),
        slot.hasAttribute('data-hidden'),
      ]),
    )

  it('replaces the panel in place when another is chosen, keeping the first webview alive and hidden', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    const graphs = webviews()[0]

    show('activity')
    await waitFor(() => expect(webviews()).toHaveLength(2))
    expect(hiddenByPartition()).toEqual({ 'ostia-ext-graphs': true, 'ostia-ext-activity': false })
    const slot = graphs.closest('.right-panel-slot') as HTMLElement
    expect(slot.inert).toBe(true)

    show('graphs')
    await waitFor(() =>
      expect(hiddenByPartition()).toEqual({
        'ostia-ext-graphs': false,
        'ostia-ext-activity': true,
      }),
    )
    expect(webviews().includes(graphs)).toBe(true)
    expect(panel).toHaveBeenCalledTimes(2)
  })

  it('never takes a webview out of the document while panels are switched, hidden and shown', async () => {
    setup()
    render(<RightPanel />)
    const removed: Node[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes)
    })
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    show('activity')
    await waitFor(() => expect(webviews()).toHaveLength(2))
    observer.observe(dock(), { childList: true, subtree: true })

    show('graphs')
    show('activity')
    act(() => useSidePanelStore.getState().hideRight())
    show('graphs')
    show('trellis')
    await waitFor(() => expect(webviews()).toHaveLength(3))
    observer.disconnect()

    expect(removed.filter((n) => n instanceof HTMLElement && n.querySelector?.('webview'))).toEqual(
      [],
    )
    expect(removed.filter((n) => n instanceof HTMLElement && n.tagName === 'WEBVIEW')).toEqual([])
  })

  it('hides without removing anything from the document, so no guest reloads', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    const graphs = webviews()[0]

    act(() => useSidePanelStore.getState().hideRight())

    expect(dock()).toHaveAttribute('data-hidden')
    expect(dock().isConnected).toBe(true)
    expect(webviews()[0]).toBe(graphs)
    expect(graphs.isConnected).toBe(true)
  })

  it('keeps three instances and evicts the least recently shown, which resolves again when shown', async () => {
    setup()
    render(<RightPanel />)
    for (const id of ['graphs', 'activity', 'trellis']) {
      show(id)
      await waitFor(() =>
        expect(panel).toHaveBeenCalledTimes(['graphs', 'activity', 'trellis'].indexOf(id) + 1),
      )
    }
    await waitFor(() => expect(webviews()).toHaveLength(3))

    show('keeper')
    await waitFor(() =>
      expect(webviews().map((w) => w.getAttribute('partition'))).toEqual([
        'ostia-ext-activity',
        'ostia-ext-keeper',
        'ostia-ext-trellis',
      ]),
    )

    show('graphs')
    await waitFor(() => expect(panel).toHaveBeenCalledTimes(5))
    expect(panel).toHaveBeenLastCalledWith('graphs', { workspaceId: 'w1', locale: 'en' })
  })

  it('resolves a panel at the path it was opened with', async () => {
    setup()
    render(<RightPanel />)
    show('keeper', { workspaceId: 'w1', path: '/approvals' })

    await waitFor(() => expect(webviews()).toHaveLength(1))
    expect(panel).toHaveBeenCalledWith('keeper', {
      workspaceId: 'w1',
      locale: 'en',
      path: '/approvals',
    })
  })

  it('gives each workspace its own instance and keeps the first when the human switches away', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    const first = webviews()[0]

    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w2' }))

    await waitFor(() => expect(webviews()).toHaveLength(2))
    expect(webviews()[0]).toBe(first)
    expect(webviews()[1].getAttribute('src')).toBe('http://127.0.0.1:4100/graphs/w2')
    expect(panel).toHaveBeenCalledWith('graphs', { workspaceId: 'w2', locale: 'en' })
  })

  it('does not load a panel in a sandboxed workspace until the human asks for it there', async () => {
    setup()
    useSandboxStore.setState({ enabled: { w1: true } })
    render(<RightPanel />)
    show('graphs')

    expect(await screen.findByText('Closed in a sandboxed workspace.')).toBeVisible()
    expect(webviews()).toHaveLength(0)
    expect(panel).not.toHaveBeenCalled()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Show Graphs' }))

    await waitFor(() => expect(webviews()).toHaveLength(1))
    expect(panel).toHaveBeenCalledWith('graphs', { workspaceId: 'w1', locale: 'en' })
    expect(screen.queryByText('Closed in a sandboxed workspace.')).toBeNull()
  })

  it('loads in an unsandboxed workspace and asks again in a sandboxed one the human switches to', async () => {
    setup()
    useSandboxStore.setState({ enabled: { w2: true } })
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w2' }))

    expect(await screen.findByRole('button', { name: 'Show Graphs' })).toBeVisible()
    expect(panel).toHaveBeenCalledTimes(1)
  })

  it('closes and drops its instances when the extension is disabled', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    act(() =>
      useExtensionsStore.setState({
        list: [panelInfo('graphs', 'Graphs', false), ...PANELS.slice(1)],
      }),
    )

    await waitFor(() => expect(webviews()).toHaveLength(0))
    expect(useSidePanelStore.getState().right).toBeNull()
    expect(useSidePanelStore.getState().kept).toEqual([])
    expect(dock()).toHaveAttribute('data-hidden')
  })

  it('stays closed for a restored panel until its extension is known, then shows it', async () => {
    setup()
    useExtensionsStore.setState({ list: [] })
    useSidePanelStore.setState({ right: 'graphs' })
    render(<RightPanel />)
    expect(dock()).toHaveAttribute('data-hidden')

    act(() => useExtensionsStore.setState({ list: PANELS }))

    await waitFor(() => expect(webviews()).toHaveLength(1))
    expect(dock()).not.toHaveAttribute('data-hidden')
  })

  it('shows Git as the Changes list alone, kept alive like an extension panel, and never behind a Show step', async () => {
    setup()
    useSandboxStore.setState({ enabled: { w1: true } })
    render(<RightPanel />)

    show('git')

    await waitFor(() => expect(document.querySelector('#right-panel .git-surface')).not.toBeNull())
    expect(screen.getByRole('complementary', { name: 'Git' })).toBe(dock())
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Changes'])
    expect(
      document.querySelector('#right-panel .git-surface .tabs-end [data-panel-close]'),
    ).not.toBeNull()
    expect(screen.queryByText('Closed in a sandboxed workspace.')).toBeNull()
    const surface = document.querySelector('#right-panel .git-surface')

    show('graphs')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show Graphs' })).toBeVisible())
    show('git')

    expect(document.querySelector('#right-panel .git-surface')).toBe(surface)
  })

  it('draws the core toolbar row above every panel slot with the close last, outside the webview', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    show('activity')
    await waitFor(() => expect(webviews()).toHaveLength(2))

    const slots = [...document.querySelectorAll<HTMLElement>('.right-panel-slot')]
    expect(slots).toHaveLength(2)
    for (const slot of slots) {
      const row = slot.querySelector('.panel-toolbar') as HTMLElement
      expect(row).not.toBeNull()
      expect(row.querySelector('webview')).toBeNull()
      expect(row.nextElementSibling?.querySelector('webview')).not.toBeNull()
      expect(row.querySelector('.panel-toolbar-actions')?.lastElementChild).toHaveAttribute(
        'data-panel-close',
      )
    }
    expect(screen.getByRole('button', { name: 'Close Activity' })).toBeVisible()
  })

  it('closes the panel from the core row and returns the keyboard to the pane only from inside it', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close Graphs' }))

    expect(useSidePanelStore.getState().right).toBeNull()
    expect(dock()).toHaveAttribute('data-hidden')
  })

  it('shows the declared tabs and actions in the core row and switches tabs from it', async () => {
    setup()
    useExtensionsStore.setState({ list: [toolbarInfo()] })
    render(<RightPanel />)
    show('trellis')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Board', 'Vault'])
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Vault' }))

    expect(usePanelToolbarStore.getState().entries).toEqual([
      { extId: 'trellis', workspaceId: 'w1', state: { tab: 'vault' } },
    ])
    expect(screen.getByRole('tab', { name: 'Vault' })).toHaveAttribute('aria-selected', 'true')
  })

  it('replaces the tabs and actions with Back and the sub-screen title the page asks for', async () => {
    setup()
    useExtensionsStore.setState({ list: [toolbarInfo()] })
    render(<RightPanel />)
    show('trellis')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    act(() =>
      usePanelToolbarStore
        .getState()
        .setEntries([{ extId: 'trellis', workspaceId: 'w1', state: { back: 'Add a rule' } }]),
    )

    expect(screen.getByText('Add a rule')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close Trellis' })).toBeVisible()
  })

  it('moves focus to Back when an action opens a sub-screen and back to the action when it closes', async () => {
    setup()
    useExtensionsStore.setState({
      list: [
        {
          ...toolbarInfo(),
          panel: {
            title: 'Trellis',
            toolbar: {
              tabs: [{ id: 'board', title: 'Board' }],
              actions: [{ id: 'add', icon: 'plus', title: 'Add a rule' }],
            },
          },
        } as unknown as ExtensionInfo,
      ],
    })
    render(<RightPanel />)
    show('trellis')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    const entry = (state: object) => [{ extId: 'trellis', workspaceId: 'w1', state }]

    await userEvent.setup().click(screen.getByRole('button', { name: 'Add a rule' }))
    act(() => usePanelToolbarStore.getState().setEntries(entry({ back: 'Add a rule' })))
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()

    act(() => usePanelToolbarStore.getState().setEntries(entry({ tab: 'board' })))
    expect(screen.getByRole('button', { name: 'Add a rule' })).toHaveFocus()
  })

  it('draws the same core row with the close above the sandboxed Show step', async () => {
    setup()
    useSandboxStore.setState({ enabled: { w1: true } })
    render(<RightPanel />)
    show('graphs')

    expect(await screen.findByRole('button', { name: 'Show Graphs' })).toBeVisible()
    const close = screen.getByRole('button', { name: 'Close Graphs' })
    expect(close).toBeVisible()
    expect(close.closest('.right-panel-sandboxed')).not.toBeNull()
    await userEvent.setup().click(close)

    expect(useSidePanelStore.getState().right).toBeNull()
  })

  it('has no Git panel when Git is switched off', async () => {
    setup()
    useSettingsStore.getState().setGit({ enabled: false })
    useSidePanelStore.setState({ right: 'git' })
    render(<RightPanel />)

    expect(dock()).toHaveAttribute('data-hidden')
    expect(document.querySelector('#right-panel .git-surface')).toBeNull()
  })

  it('watches git only for the Git panel that is shown, and stops reading when it is hidden or another workspace is shown', async () => {
    setup()
    const git = window.ostia.git
    const off = vi.fn()
    vi.mocked(git.onChanged).mockReturnValue(off)
    vi.mocked(git.changes).mockClear()
    render(<RightPanel />)
    show('git')
    await waitFor(() => expect(watchedWorkspaces('git')).toEqual(['w1']))
    await waitFor(() => expect(git.changes).toHaveBeenCalledTimes(1))

    show('graphs')
    await waitFor(() => expect(watchedWorkspaces('git')).toEqual([]))
    expect(off).toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(git.changes).toHaveBeenCalledTimes(1)

    show('git')
    await waitFor(() => expect(watchedWorkspaces('git')).toEqual(['w1']))
    await waitFor(() => expect(git.changes).toHaveBeenCalledTimes(2))

    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w2' }))
    await waitFor(() => expect(watchedWorkspaces('git')).toEqual(['w2']))

    act(() => useSidePanelStore.getState().hideRight())
    await waitFor(() => expect(watchedWorkspaces('git')).toEqual([]))
  })

  it('drops the live instances of a workspace that is closed at once', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w2' }))
    await waitFor(() => expect(webviews()).toHaveLength(2))

    act(() =>
      useWorkspacesStore.setState({ workspaces: [workspace('w2')], activeWorkspaceId: 'w2' }),
    )

    await waitFor(() => expect(webviews()).toHaveLength(1))
    expect(webviews()[0].getAttribute('src')).toBe('http://127.0.0.1:4100/graphs/w2')
  })

  it('asks again when a workspace with a live panel becomes sandboxed, and unloads the panel', async () => {
    setup()
    render(<RightPanel />)
    show('graphs')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    act(() => useSandboxStore.setState({ enabled: { w1: true } }))

    expect(await screen.findByRole('button', { name: 'Show Graphs' })).toBeVisible()
    expect(webviews()).toHaveLength(0)
  })

  it('draws the Inbox of a built-in extension in core for its surface tab, keeps the page mounted and hidden, and shows the loud count', async () => {
    setup()
    useExtensionsStore.setState({ list: [inboxInfo(true)] })
    useApprovalsStore.setState({
      pending: [
        { id: 'a1', paneId: 'p1', workspaceId: 'w1', caps: [], action: 'Run', detail: '', at: 1 },
      ],
    })
    useInboxStore.getState().setEntries([
      {
        extId: 'activity',
        workspaceId: 'w1',
        items: [{ id: 'abcdefghij', text: 'Set the key', at: 2 }],
      },
    ])
    usePanelToolbarStore.setState({
      entries: [{ extId: 'activity', workspaceId: 'w1', state: { tab: 'inbox' } }],
    })
    render(<RightPanel />)
    show('activity')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    expect(screen.getByRole('list', { name: 'Inbox' })).toBeVisible()
    expect(screen.getByText('Set the key')).toBeVisible()
    const web = document.querySelector('.right-panel-web') as HTMLElement
    expect(web).toHaveAttribute('data-hidden')
    expect(web.inert).toBe(true)
    expect(screen.getByRole('tab', { name: /Inbox/ })).toHaveTextContent('2')

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Recap' }))

    expect(screen.queryByRole('list', { name: 'Inbox' })).toBeNull()
    expect(web).not.toHaveAttribute('data-hidden')
    expect(webviews()).toHaveLength(1)
  })

  it('keeps the Inbox the human chose when the page reports another tab, until the human picks one', async () => {
    setup()
    useExtensionsStore.setState({ list: [inboxInfo(true)] })
    usePanelToolbarStore.setState({
      entries: [{ extId: 'activity', workspaceId: 'w1', state: { tab: 'recap' } }],
    })
    render(<RightPanel />)
    show('activity')
    await waitFor(() => expect(webviews()).toHaveLength(1))
    expect(screen.queryByText('Nothing waits for you.')).toBeNull()

    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: /Inbox/ }))
    expect(await screen.findByText('Nothing waits for you.')).toBeVisible()

    await act(async () => {
      usePanelToolbarStore.getState().setEntries([
        {
          extId: 'activity',
          workspaceId: 'w1',
          state: { tab: 'recap', badges: { remember: 1 } },
        },
      ])
    })
    expect(screen.getByText('Nothing waits for you.')).toBeVisible()
    expect(screen.getByRole('tab', { name: /Inbox/ })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: 'Recap' }))
    expect(screen.queryByText('Nothing waits for you.')).toBeNull()
  })

  it('leaves the page of an extension that is not built in alone, whatever its tab declares', async () => {
    setup()
    useExtensionsStore.setState({ list: [inboxInfo(false)] })
    render(<RightPanel />)
    show('activity')
    await waitFor(() => expect(webviews()).toHaveLength(1))

    expect(screen.queryByText('Nothing waits for you.')).toBeNull()
    expect(document.querySelector('.right-panel-inbox')).toBeNull()
    expect(document.querySelector('.right-panel-web')).not.toHaveAttribute('data-hidden')
  })
})
