import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLinks } from './terminalLinks'
import type { TerminalSession } from './terminalSession'

describe('clicking a link of another scheme in the terminal', () => {
  afterEach(() => vi.mocked(window.ostia.openPath.openLink).mockReset())

  it('hands slack and zed links to the app that owns them on a plain click', () => {
    const links = createTerminalLinks({
      host: document.createElement('div'),
      paneId: 'pane-links',
      workspaceIdRef: { current: 'w1' },
      session: { cwd: '/w', remote: null } as unknown as TerminalSession,
      setLinkHint: vi.fn(),
    })
    const term = {
      hasSelection: () => false,
      modes: { mouseTrackingMode: 'none' },
      onScroll: () => ({ dispose: vi.fn() }),
      onResize: () => ({ dispose: vi.fn() }),
    } as unknown as OstiaTerminal
    const detach = links.attach(term, null)

    for (const uri of ['slack://channel?id=1', 'zed://file/tmp/a']) {
      links.openWebLink(new MouseEvent('click', { detail: 1 }), uri)
    }

    expect(vi.mocked(window.ostia.openPath.openLink).mock.calls).toEqual([
      ['slack://channel?id=1'],
      ['zed://file/tmp/a'],
    ])
    detach()
  })
})
