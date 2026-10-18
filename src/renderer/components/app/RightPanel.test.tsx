import '@testing-library/jest-dom/vitest'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'
import { RightPanel } from './RightPanel'

const panelInfo = (id: string, title: string, enabled = true): ExtensionInfo =>
  ({ id, name: title, enabled, assist: [], panel: { title } }) as unknown as ExtensionInfo

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
  const panel = vi.fn()

  beforeAll(() => {
    sideInit = useSidePanelStore.getState()
    extInit = useExtensionsStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    sandboxInit = useSandboxStore.getState()
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
    panel.mockReset()
    useSidePanelStore.setState(sideInit, true)
    useExtensionsStore.setState(extInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useSandboxStore.setState(sandboxInit, true)
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
})
