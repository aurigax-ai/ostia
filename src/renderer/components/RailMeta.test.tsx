import '@testing-library/jest-dom/vitest'
import type { ExtensionSidebarItem } from '@shared/extensions'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { DeckRail } from './DeckRail'

const ITEM_WIDTH = 40
const MORE_WIDTH = 20
const LINE_WIDTH = 120

const branch: ExtensionSidebarItem = {
  extId: 'git',
  key: 'branch',
  workspaceId: 's1',
  text: 'dev +2',
  icon: 'git-branch',
  tone: 'neutral',
  kind: 'location',
}

const port = (n: number): ExtensionSidebarItem => ({
  extId: 'ports',
  key: `port:${n}`,
  workspaceId: 's1',
  text: `:${n}`,
  tone: 'neutral',
  kind: 'live',
  url: `http://localhost:${n}/`,
})

function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = this.classList.contains('rail-meta-probe')
      ? MORE_WIDTH
      : this.classList.contains('ext-item')
        ? ITEM_WIDTH
        : 0
    return { width, height: 16, top: 0, left: 0, right: width, bottom: 16, x: 0, y: 0 } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('rail-meta') ? LINE_WIDTH : 0
  })
}

function row(): HTMLElement {
  return screen.getByRole('button', { name: /avail/ }).closest('.rail-tab') as HTMLElement
}

describe('workspace row meta lines', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    extensionsInit = useExtensionsStore.getState()
    settingsInit = useSettingsStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    useSettingsStore.setState(settingsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    vi.restoreAllMocks()
  })

  function seed(items: ExtensionSidebarItem[]): void {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 's1',
          name: 'avail',
          kind: 'terminal',
          workDir: '/home/me/Personal/goji/avail',
          projectDir: '~/Personal/goji/avail',
          state: 'idle',
        },
      ],
      activeWorkspaceId: 's1',
    })
    render(<DeckRail />)
    act(() => useExtensionsStore.setState({ sidebar: items }))
  }

  it('puts the folder and branch on one line and ports on their own line', () => {
    seed([branch, port(3000), port(5173)])
    const location = row().querySelector('.rail-meta.location') as HTMLElement
    const live = row().querySelector('.rail-meta.live') as HTMLElement
    expect(within(location).getByText('~/Personal/goji/avail')).toHaveClass('rail-meta-path')
    expect(within(location).getByText('dev +2')).toBeInTheDocument()
    expect(within(live).getByText(':3000')).toBeInTheDocument()
    expect(within(live).getByText(':5173')).toBeInTheDocument()
    expect(within(location).queryByText(':3000')).toBeNull()
  })

  it('labels an item with its badge before the text', () => {
    seed([
      {
        extId: 'ports',
        key: 'ssh',
        workspaceId: 's1',
        text: '192.168.2.25',
        badge: 'SSH',
        tone: 'neutral',
        kind: 'live',
      },
    ])
    const item = row().querySelector('.rail-meta.live .ext-item') as HTMLElement
    expect(item).toHaveTextContent('SSH192.168.2.25')
    expect(within(item).getByText('SSH')).not.toBe(within(item).getByText('192.168.2.25'))
  })

  it('shows no live line without live items', () => {
    seed([branch])
    expect(row().querySelector('.rail-meta.location')).not.toBeNull()
    expect(row().querySelector('.rail-meta.live')).toBeNull()
  })

  it('treats an item without a location kind as live', () => {
    seed([{ ...branch, key: 'cards', text: '4 open', kind: 'live' }])
    expect(row().querySelector('.rail-meta.live')).toHaveTextContent('4 open')
  })

  it('shows the ports that fit plus a +N that lists the rest and opens them', async () => {
    stubLayout()
    seed([3001, 3002, 3003, 3004, 3005, 3006].map(port))
    const live = row().querySelector('.rail-meta.live') as HTMLElement
    expect(within(live).getByText(':3001')).toBeInTheDocument()
    expect(within(live).getByText(':3002')).toBeInTheDocument()
    expect(within(live).queryByText(':3003')).toBeNull()
    const more = within(live).getByRole('button', { name: '4 more' })
    expect(more).toHaveTextContent('+4')

    const user = userEvent.setup()
    await user.click(more)
    const hidden = await screen.findByText(':3006')
    expect(screen.getByText(':3003')).toBeInTheDocument()
    await user.click(hidden)
    expect(useLayoutStore.getState().byWorkspace.s1?.root).toMatchObject({
      kind: 'browser',
      url: 'http://localhost:3006/',
    })
  })

  it('shortens the folder from the middle to fit beside the branch', () => {
    stubLayout()
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('rail-meta-path') ? (this.textContent?.length ?? 0) * 5 : 0
    })
    seed([branch])
    expect(row().querySelector('.rail-meta-path')).toHaveTextContent('~/…/goji/avail')
  })
})
