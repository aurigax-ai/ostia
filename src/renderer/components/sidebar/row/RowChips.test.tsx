import '@testing-library/jest-dom/vitest'
import type { ExtensionSidebarItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { MailItem } from '@shared/agents/mailApi'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createTerminalPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { layoutOf } from '@/lib/panes/layoutPatch'
import { useMailStore } from '@/stores/agents/mailStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { RowChips } from './RowChips'

const pane = (id: string, over: Partial<PaneNode> = {}): PaneNode => ({
  ...createTerminalPane('zsh', '/x'),
  id,
  ...over,
})

const branch: ExtensionSidebarItem = {
  extId: 'git',
  key: 'branch',
  workspaceId: 'w1',
  text: 'main',
  tone: 'neutral',
  kind: 'location',
}

function show(chips: ExtensionSidebarItem[] = []) {
  return render(
    <TooltipProvider>
      <RowChips workspaceId="w1" chips={chips} />
    </TooltipProvider>,
  )
}

function layout(...panes: PaneNode[]): void {
  const [first, ...rest] = panes
  const root = rest.length === 0 ? first : { ...layoutOf(first).root }
  useLayoutStore.setState({
    byWorkspace: {
      w1: {
        root:
          rest.length === 0 ? root : { type: 'tabs', id: 't', children: panes, activeId: first.id },
        activePaneId: first.id,
        zoomedPaneId: null,
      },
    },
  })
}

beforeEach(() => useMailStore.setState({ byPane: {} }))
afterEach(cleanup)

describe('RowChips', () => {
  it('counts live terminal tabs of every agent kind and leaves out sleeping ones', () => {
    layout(
      pane('a'),
      pane('b', { kind: 'agent' }),
      pane('c', { hibernated: true }),
      pane('d', { kind: 'browser' }),
    )
    show()
    expect(screen.getByRole('img', { name: '2 terminal tabs' })).toHaveTextContent('2')
  })

  it('says one tab in the singular and hides the count at zero', () => {
    layout(pane('a'))
    const { unmount } = show()
    expect(screen.getByRole('img', { name: '1 terminal tab' })).toBeInTheDocument()
    unmount()
    layout(pane('a', { hibernated: true }))
    show()
    expect(screen.queryByRole('img', { name: /terminal tab/ })).toBeNull()
  })

  it('orders the count, then mail, then the branch', () => {
    layout(pane('a'))
    useMailStore.setState({
      byPane: {
        a: [
          {
            id: 'm',
            state: 'queued',
            from: { label: 'x' },
            ts: new Date().toISOString(),
            pending: 'idle-no-wake',
          } as MailItem,
        ],
      },
    })
    const { container } = show([branch])
    const parts = [
      screen.getByRole('img', { name: '1 terminal tab' }),
      screen.getByRole('img', { name: '1 unread message for this agent' }),
      screen.getByText('main'),
    ]
    for (const [i, part] of parts.slice(0, -1).entries()) {
      expect(
        part.compareDocumentPosition(parts[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    expect(container.querySelector('.rail-chips')).not.toBeNull()
  })
})
