import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { type JSX, type ReactNode, useRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tabsOf } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode, SplitNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { PaneTree } from './PaneTree'

interface AllotmentMount {
  vertical?: boolean
  defaultSizes?: number[]
}

const mounts: AllotmentMount[] = []

vi.mock('allotment', async () => {
  const { forwardRef } = await import('react')
  const Allotment = forwardRef(function Allotment(
    props: AllotmentMount & { children?: ReactNode },
    _ref,
  ): JSX.Element {
    const mounted = useRef(false)
    if (!mounted.current) {
      mounted.current = true
      mounts.push({ vertical: props.vertical, defaultSizes: props.defaultSizes })
    }
    return <div className="allotment-fake">{props.children}</div>
  })
  const Pane = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return { Allotment: Object.assign(Allotment, { Pane }) }
})

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  mounts.length = 0
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
})

function workspaceWithTerminal(): string {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w',
  })
  useLayoutStore.getState().ensure('w')
  return useLayoutStore.getState().byWorkspace.w.activePaneId
}

function holds(node: LayoutNode, paneId: string): boolean {
  return node.type === 'pane' ? node.id === paneId : node.children.some((c) => holds(c, paneId))
}

function splitHolding(node: LayoutNode, paneId: string): SplitNode | null {
  if (node.type === 'pane') return null
  for (const child of node.children) {
    const found = splitHolding(child, paneId)
    if (found) return found
  }
  return node.type === 'split' && holds(node, paneId) ? node : null
}

function openedSplit(open: () => string | null): SplitNode {
  let paneId: string | null = null
  act(() => {
    paneId = open()
  })
  if (!paneId) throw new Error('nothing opened')
  const split = splitHolding(useLayoutStore.getState().byWorkspace.w.root, paneId)
  if (!split) throw new Error('the panel is in no split')
  return split
}

describe('PaneTree', () => {
  it('the Git panel opened from its toggle is painted only at its split position', () => {
    workspaceWithTerminal()
    render(<PaneTree workspaceId="w" />)
    expect(mounts).toEqual([])

    const split = openedSplit(() => useLayoutStore.getState().openGit('w', 'Git'))

    expect(split.sizes).toHaveLength(2)
    expect(mounts).toEqual([{ vertical: false, defaultSizes: split.sizes }])
  })

  it('a view panel opened into a nested split is painted only at its split position', () => {
    const upper = workspaceWithTerminal()
    act(() => useLayoutStore.getState().split('w', upper, 'vertical'))
    render(<PaneTree workspaceId="w" />)
    const before = mounts.length

    const split = openedSplit(() => useLayoutStore.getState().openView('w', 'board', 'Board'))

    expect(split.direction).toBe('horizontal')
    expect(mounts.slice(before)).toContainEqual({ vertical: false, defaultSizes: split.sizes })
  })

  it('a pane split inside a split tab is painted only at its split position', () => {
    const upper = workspaceWithTerminal()
    const pane = useLayoutStore.getState().byWorkspace.w.root as PaneNode
    useLayoutStore.setState({
      byWorkspace: { w: { root: tabsOf(upper, pane), activePaneId: upper, zoomedPaneId: null } },
    })
    act(() => useLayoutStore.getState().split('w', upper, 'vertical'))
    render(<PaneTree workspaceId="w" />)
    expect(document.querySelector('.pane-split-body')).not.toBeNull()
    const lower = useLayoutStore.getState().byWorkspace.w.activePaneId
    const before = mounts.length

    const split = openedSplit(() => {
      useLayoutStore.getState().split('w', lower, 'horizontal')
      return useLayoutStore.getState().byWorkspace.w.activePaneId
    })

    expect(document.querySelectorAll('.pane-split-body')).toHaveLength(1)
    expect(mounts.slice(before)).toContainEqual({ vertical: false, defaultSizes: split.sizes })
  })
})
