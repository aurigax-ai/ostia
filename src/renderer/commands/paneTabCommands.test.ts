import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPane, findSplitTabByName, paneIds, splitOf, tabsOf } from '@/lib/layout/tree'
import type { SplitNode } from '@/lib/layout/types'
import { forgetSplitTabSeeds } from '@/lib/panes/splitTabSeeds'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { releaseSurfaces, setFocusTarget, surfaceHost } from '@/stores/workspaces/surfaceSlotsStore'
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
  releaseSurfaces(new Set())
  document.body.replaceChildren()
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

  it("joins only split tabs an agent made; a tab the human named or renamed is the human's", async () => {
    const { a, b, c } = workspace()
    const join = (paneIds: string[], tab: string) =>
      commands.execWith(fromMain, 'pane.joinTab', { paneIds, tab })
    expect((await join([b.id, c.id], 'workers')).ok).toBe(true)
    expect((await join([a.id], 'workers')).ok).toBe(true)

    const root = () => useLayoutStore.getState().byWorkspace.s1.root
    const made = findSplitTabByName(root(), 'workers') as SplitNode
    useLayoutStore.getState().renameSplitTab('s1', made.id, 'mine')
    const refused = await join([a.id], 'mine')
    expect(refused.ok ? '' : refused.error.message).toContain(
      "human-tab: split tab mine is the human's",
    )
    const plan = await commands.execWith(fromMain, 'pane.tabPlan', { paneIds: [], tab: 'mine' })
    expect(plan).toMatchObject({ ok: true, result: { human: 'mine' } })
    const out = await commands.execWith(fromMain, 'pane.joinTab', { paneIds: [b.id], tab: null })
    expect(out.ok ? '' : out.error.message).toContain('human-tab')
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

describe('pane.collapse', () => {
  function surfaceWithInput(paneId: string): HTMLTextAreaElement {
    const input = document.createElement('textarea')
    surfaceHost(paneId).appendChild(input)
    document.body.appendChild(surfaceHost(paneId))
    setFocusTarget(paneId, () => input)
    return input
  }

  function splitTab() {
    const [a, b] = [createPane('terminal'), createPane('terminal')]
    const tab: SplitNode = { ...splitOf('horizontal', a, b), name: 'workers' }
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: tabsOf(a.id, createPane('terminal'), tab),
          activePaneId: a.id,
          zoomedPaneId: null,
        },
      },
    })
    return { a, b }
  }

  it('moves the keyboard to the pane shown next when the collapsed pane held it', async () => {
    const { a, b } = splitTab()
    surfaceWithInput(a.id).focus()
    const next = surfaceWithInput(b.id)
    await commands.execWith(fromMain, 'pane.collapse', { paneId: a.id })
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(b.id)
    expect(document.activeElement).toBe(next)
  })

  it('leaves the keyboard where it was when the collapsed pane did not hold it', async () => {
    const { a, b } = splitTab()
    surfaceWithInput(a.id)
    surfaceWithInput(b.id)
    const button = document.body.appendChild(document.createElement('button'))
    button.focus()
    await commands.execWith(fromMain, 'pane.collapse', { paneId: a.id })
    expect(document.activeElement).toBe(button)
  })
})
