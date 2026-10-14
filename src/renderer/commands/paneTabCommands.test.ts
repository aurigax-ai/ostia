import { createPane, findSplitTabByName, paneIds, splitOf, tabsOf } from '@/layout/tree'
import type { SplitNode } from '@/layout/types'
import { forgetSplitTabSeeds } from '@/lib/panes/splitTabSeeds'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { registerPaneTabCommands } from './paneTabCommands'
import { commands } from './registry'

let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  registerPaneTabCommands()
  layoutInit = useLayoutStore.getState()
})

afterEach(() => {
  forgetSplitTabSeeds(
    Object.values(useLayoutStore.getState().byWorkspace).flatMap((l) => paneIds(l.root)),
  )
  useLayoutStore.setState(layoutInit, true)
})

function workspace() {
  const [a, b, c] = [createPane('terminal'), createPane('terminal'), createPane('terminal')]
  const locked = { ...createPane('terminal'), locked: true as const }
  useLayoutStore.setState({
    byWorkspace: {
      s1: { root: tabsOf(a.id, a, b, c, locked), activePaneId: a.id, zoomedPaneId: null },
    },
  })
  return { a, b, c, locked }
}

const fromMain = {
  activeWorkspaceId: 's1',
  activePaneId: null,
  target: { workspaceId: 's1', paneId: null },
}

describe('pane.joinTab', () => {
  it('joins panes into a named split tab and reports them', async () => {
    const { b, c } = workspace()
    const res = await commands.execWith(fromMain, 'pane.joinTab', {
      paneIds: [b.id, c.id],
      tab: 'workers',
    })
    expect(res).toMatchObject({ ok: true, result: { moved: [b.id, c.id] } })
    const root = useLayoutStore.getState().byWorkspace.s1.root
    expect(paneIds(findSplitTabByName(root, 'workers') as SplitNode)).toEqual([b.id, c.id])
  })

  it('reports whole when the joined panes are all of the workspace, from tabs or a plain split', async () => {
    for (const shape of ['tabs', 'split'] as const) {
      const [a, b] = [createPane('terminal'), createPane('terminal')]
      const root = shape === 'tabs' ? tabsOf(a.id, a, b) : splitOf('horizontal', a, b)
      useLayoutStore.setState({
        byWorkspace: { s1: { root, activePaneId: a.id, zoomedPaneId: null } },
      })
      const res = await commands.execWith(fromMain, 'pane.joinTab', {
        paneIds: [a.id, b.id],
        tab: 'workers',
      })
      expect(res, shape).toMatchObject({ ok: true, result: { whole: true } })
      expect(paneIds(useLayoutStore.getState().byWorkspace.s1.root), shape).toEqual([a.id, b.id])
    }
    const { b, c } = workspace()
    const res = await commands.execWith(fromMain, 'pane.joinTab', {
      paneIds: [b.id, c.id],
      tab: 'workers',
    })
    expect(res).toMatchObject({ ok: true, result: { whole: false } })
  })

  it('refuses a locked pane and changes nothing', async () => {
    const { b, locked } = workspace()
    const before = useLayoutStore.getState().byWorkspace.s1.root
    const res = await commands.execWith(fromMain, 'pane.joinTab', {
      paneIds: [b.id, locked.id],
      tab: 'workers',
    })
    expect(res.ok ? '' : res.error.message).toContain('pane-locked')
    expect(useLayoutStore.getState().byWorkspace.s1.root).toBe(before)
  })

  it('plans with the members of the named tab and the locked panes', async () => {
    const { a, b, c, locked } = workspace()
    await commands.execWith(fromMain, 'pane.joinTab', { paneIds: [b.id, c.id], tab: 'workers' })
    const res = await commands.execWith(fromMain, 'pane.tabPlan', {
      paneIds: [a.id, locked.id],
      tab: 'workers',
    })
    expect(res).toMatchObject({ ok: true, result: { members: [b.id, c.id], locked: [locked.id] } })
  })
})
