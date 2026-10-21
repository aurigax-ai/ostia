import { afterEach, describe, expect, it, vi } from 'vitest'
import { tabMark } from '@/lib/attention/attention'
import { registerBrowserHandle } from '@/lib/browser/browserHandles'
import { paneBrowserProfile, setPaneBrowser } from '@/lib/layout/paneFields'
import { createPane, findPane, paneIds, tabsOfPane } from '@/lib/layout/tree'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { openLinkTab, wireLinkTabs } from './linkTabs'

const initialLayout = useLayoutStore.getState()
const initialAttention = useAttentionStore.getState()
const offs: (() => void)[] = []

afterEach(() => {
  for (const off of offs.splice(0)) off()
  useLayoutStore.setState(initialLayout, true)
  useAttentionStore.setState(initialAttention, true)
})

function seed() {
  const term = createPane()
  const web = createPane('browser')
  useLayoutStore.setState({
    byWorkspace: {
      s1: {
        root: setPaneBrowser(
          {
            type: 'split',
            id: 'sp',
            direction: 'horizontal',
            children: [term, web],
            sizes: [1, 1],
          },
          web.id,
          'https://site.example/',
          'shared',
        ),
        activePaneId: web.id,
        zoomedPaneId: null,
      },
    },
  })
  offs.push(
    registerBrowserHandle(web.id, {
      guestId: () => 7,
      focusAddress: vi.fn(),
      reload: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      find: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    }),
  )
  return web
}

const layout = () => useLayoutStore.getState().byWorkspace.s1

describe('openLinkTab', () => {
  it('shows a new tab beside the opener on the opener’s profile', () => {
    const web = seed()
    const opened = openLinkTab({ guestId: 7, url: 'https://docs.example/', background: false })
    const pane = findPane(layout().root, opened ?? '')
    expect(pane).toMatchObject({ kind: 'browser', url: 'https://docs.example/' })
    expect(pane && paneBrowserProfile(pane)).toBe('shared')
    expect(layout().activePaneId).toBe(opened)
    expect(tabsOfPane(layout().root, web.id)?.activeId).toBe(opened)
    expect(paneIds(tabsOfPane(layout().root, web.id) ?? web)).toEqual([web.id, opened])
    expect(tabMark(useAttentionStore.getState().byPane[opened ?? ''])).toBeNull()
  })

  it('opens a background tab beside the opener with the unread mark, keeping the opener shown', () => {
    const web = seed()
    const opened = openLinkTab({ guestId: 7, url: 'https://docs.example/', background: true })
    expect(findPane(layout().root, opened ?? '')).toMatchObject({ url: 'https://docs.example/' })
    expect(layout().activePaneId).toBe(web.id)
    expect(tabsOfPane(layout().root, web.id)?.activeId).toBe(web.id)
    expect(tabMark(useAttentionStore.getState().byPane[opened ?? ''])).toBe('unread')
  })

  it('opens nothing for a guest no pane holds', () => {
    seed()
    const before = layout()
    expect(openLinkTab({ guestId: 8, url: 'https://docs.example/', background: false })).toBeNull()
    expect(layout()).toBe(before)
  })

  it('listens to main for the whole life of the app', () => {
    const off = vi.fn()
    vi.mocked(window.ostia.browser.onOpenTab).mockReturnValueOnce(off)
    expect(wireLinkTabs()).toBe(off)
    expect(window.ostia.browser.onOpenTab).toHaveBeenCalledWith(openLinkTab)
  })
})
