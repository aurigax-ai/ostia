import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBrowserAs, openBrowserTabAs } from '@/lib/browser/browserProfile'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { useAppLinkStore } from '@/stores/terminal/appLinkStore'
import { createTerminalLinks } from './terminalLinks'
import type { TerminalSession } from './terminalSession'

vi.mock('@/lib/attention/workspaceActivity', () => ({ isPaneVisible: () => true }))
vi.mock('@/lib/prompt/usePromptGeometry', () => ({
  measureCells: () => ({ left: 0, top: 0, width: 8, height: 16 }),
}))
vi.mock('@/lib/browser/browserProfile', () => ({
  openBrowserAs: vi.fn(),
  openBrowserTabAs: vi.fn(),
}))

const RANGE = { start: { x: 1, y: 1 }, end: { x: 21, y: 1 } }

describe('a link of another scheme in the terminal', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(window.ostia.openPath.openLink).mockClear()
    useAppLinkStore.setState({ byPane: {} })
    vi.mocked(openBrowserAs).mockClear()
    vi.mocked(openBrowserTabAs).mockClear()
  })

  it('shows its target on hover and asks before it hands the link to its app on a plain click, opening no browser tab', async () => {
    vi.useFakeTimers()
    const setLinkHint = vi.fn()
    const links = createTerminalLinks({
      host: document.createElement('div'),
      paneId: 'pane-links',
      workspaceIdRef: { current: 'w1' },
      session: { cwd: '/w', remote: null } as unknown as TerminalSession,
      setLinkHint,
    })
    const term = {
      cols: 80,
      buffer: { active: { viewportY: 0 } },
      hasSelection: () => false,
      modes: { mouseTrackingMode: 'none' },
      onScroll: () => ({ dispose: vi.fn() }),
      onResize: () => ({ dispose: vi.fn() }),
    } as unknown as OstiaTerminal
    const detach = links.attach(term, null)

    for (const uri of ['slack://channel?id=1', 'zed://file/tmp/a']) {
      links.webLinks.hover(new MouseEvent('mouseover'), uri, RANGE)
      vi.advanceTimersByTime(500)
      expect(setLinkHint).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'web', url: uri, plainClick: true }),
      )
      links.webLinks.activate(new MouseEvent('click', { detail: 1 }), uri, RANGE)
      await vi.advanceTimersByTimeAsync(0)
      expect(useAppLinkStore.getState().byPane['pane-links']).toEqual({
        kind: 'ask',
        url: uri,
        app: 'Obsidian',
      })
    }

    expect(window.ostia.openPath.openLink).not.toHaveBeenCalled()
    expect(openBrowserAs).not.toHaveBeenCalled()
    expect(openBrowserTabAs).not.toHaveBeenCalled()
    detach()
  })
})
