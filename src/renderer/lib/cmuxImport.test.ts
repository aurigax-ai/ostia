import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type CmuxImportReport,
  type CmuxLayout,
  type CmuxSession,
  type CmuxSurface,
  parseCmuxSession,
} from '@shared/cmuxSession'
import type { SnapshotNode, SnapshotWorkspace, WindowSummary } from '@shared/types'
import { MAX_LAYOUT_DEPTH, MAX_PANES, MAX_WORKSPACES } from '@shared/workspaceLimits'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { paneIds } from '../layout/tree'
import { useCmuxImportStore } from '../stores/cmuxImportStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useWindowsStore } from '../stores/windowsStore'
import { resetWorkspaceIds, useWorkspacesStore } from '../stores/workspacesStore'
import {
  CmuxImportError,
  type ExistingWorkspace,
  planCmuxImport,
  runCmuxImport,
} from './cmuxImport'

const FIXTURE = resolve(__dirname, '../../../test/fixtures/cmux/session-com.cmuxterm.app.json')
const SESSION_PATH = '/Users/alex/Library/Application Support/cmux/session-com.cmuxterm.app.json'
const APP = '/Users/alex/Code/acme/app'

function recorded(): CmuxSession {
  const parsed = parseCmuxSession(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  if (!('session' in parsed)) throw new Error(parsed.error)
  return parsed.session
}

function strip(node: SnapshotNode): unknown {
  if (node.type === 'pane') {
    const { id: _id, ...rest } = node
    return rest
  }
  if (node.type === 'tabs') {
    return {
      tabs: node.children.map(strip),
      active: node.children.findIndex((c) => c.id === node.activeId),
    }
  }
  return { [node.direction]: node.children.map(strip), sizes: node.sizes }
}

function depthOf(node: SnapshotNode): number {
  if (node.type === 'pane') return 0
  return 1 + Math.max(...node.children.map(depthOf))
}

function snapshotPanes(node: SnapshotNode): string[] {
  if (node.type === 'pane') return [node.id]
  return node.children.flatMap(snapshotPanes)
}

function plannedHere(existing: ExistingWorkspace[] = []): SnapshotWorkspace[] {
  return planCmuxImport(recorded(), { existing, groups: true }).windows[0].map((p) => p.workspace)
}

function terminals(n: number): CmuxSurface[] {
  return Array.from({ length: n }, (_, i) => ({ type: 'terminal', title: `t${i}` }))
}

function oneWorkspace(layout: CmuxLayout): CmuxSession {
  return { windows: [{ workspaces: [{ title: 'Big', directory: '/home/u/big', layout }] }] }
}

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let windowsInit: ReturnType<typeof useWindowsStore.getState>
let sandboxInit: ReturnType<typeof useSandboxStore.getState>

beforeAll(() => {
  registerBuiltinCommands()
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  windowsInit = useWindowsStore.getState()
  sandboxInit = useSandboxStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useWindowsStore.setState(windowsInit, true)
  useSandboxStore.setState(sandboxInit, true)
  useCmuxImportStore.setState({ outcome: null })
  resetWorkspaceIds()
  vi.restoreAllMocks()
})

function serveSession(session: CmuxSession = recorded()): void {
  vi.mocked(window.ostia.workspace.readCmux).mockResolvedValue({
    ok: true,
    path: SESSION_PATH,
    session,
  })
}

const names = () => useWorkspacesStore.getState().workspaces.map((w) => w.customName ?? w.name)

describe('planCmuxImport on a recorded cmux session', () => {
  it('maps each cmux workspace to one with the same name and folder', () => {
    const plan = planCmuxImport(recorded(), { existing: [], groups: true })

    expect(
      plan.windows.map((w) => w.map((p) => [p.workspace.customName, p.workspace.workDir])),
    ).toEqual([
      [
        ['Office', '/Users/alex/Code'],
        ['App', APP],
        ['Client work', '/Users/alex/Code/work'],
        ['Editor', '/Users/alex/Code/acme'],
        ['Research', '/Users/alex/Code/acme'],
      ],
      [['Ops', '/Users/alex/Code/home/infra']],
    ])
    expect(plan.skipped).toEqual([])
  })

  it('turns surfaces into panes, a cmux pane into tabs, and keeps the split proportions', () => {
    const app = plannedHere()[1]
    if (!app.root) throw new Error('no layout')

    expect(strip(app.root)).toEqual({
      horizontal: [
        {
          tabs: [
            { type: 'pane', title: 'Server', kind: 'terminal', cwd: APP, titlePinned: true },
            {
              type: 'pane',
              title: 'Refactor',
              kind: 'terminal',
              cwd: `${APP}/src`,
              titlePinned: true,
              resume: { agent: 'codex', id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' },
            },
            { type: 'pane', title: 'Terminal', kind: 'terminal', cwd: APP, defaultTitle: true },
          ],
          active: 1,
        },
        {
          vertical: [
            { type: 'pane', title: 'Vite App', kind: 'browser', url: 'http://localhost:5173/' },
            {
              tabs: [
                {
                  type: 'pane',
                  title: 'README.md',
                  kind: 'editor',
                  cwd: APP,
                  filePath: `${APP}/README.md`,
                },
                { type: 'pane', title: 'Review', kind: 'terminal', cwd: APP, titlePinned: true },
              ],
              active: 0,
            },
          ],
          sizes: [0.25, 0.75],
        },
      ],
      sizes: [0.6, 1 - 0.6],
    })
  })

  it('focuses the pane cmux had focused and carries pin and description', () => {
    const app = plannedHere()[1]
    if (!app.root) throw new Error('no layout')
    const refactor = snapshotPanes(app.root)[1]

    const planned = planCmuxImport(recorded(), { existing: [], groups: true }).windows[0][1]

    expect(app.activePaneId).toBe(refactor)
    expect(app).toMatchObject({ name: 'app', description: 'Web client and API', kind: 'terminal' })
    expect(planned.pinned).toBe(true)
  })

  it('opens every terminal in the folder cmux had, and a remote one in the workspace folder', () => {
    const plan = planCmuxImport(recorded(), { existing: [], groups: true })
    const ops = plan.windows[1][0].workspace
    if (!ops.root) throw new Error('no layout')

    expect(strip(ops.root)).toEqual({
      vertical: [
        {
          type: 'pane',
          title: 'Deploy',
          kind: 'terminal',
          cwd: '/Users/alex/Code/home/infra',
          titlePinned: true,
        },
        {
          type: 'pane',
          title: 'db01',
          kind: 'terminal',
          cwd: '/Users/alex/Code/home/infra',
          titlePinned: true,
        },
      ],
      sizes: [0.5, 0.5],
    })
  })

  it('lists what cannot be carried over instead of dropping it silently', () => {
    const plan = planCmuxImport(recorded(), { existing: [], groups: true })
    const [here, there] = plan.windows

    expect(here[1].losses).toEqual([
      { workspace: 'App', pane: 'Server', loss: 'scrollback' },
      { workspace: 'App', pane: 'Refactor', loss: 'agent-resume', detail: 'codex' },
      { workspace: 'App', pane: 'Vite App', loss: 'browser-history' },
      { workspace: 'App', pane: 'workspaceTodo', loss: 'surface', detail: 'workspaceTodo' },
      { workspace: 'App', pane: 'Review', loss: 'agent', detail: 'gemini' },
    ])
    expect(here[0].losses).toEqual([
      { workspace: 'Office', pane: 'Kitchen', loss: 'agent-resume', detail: 'claude' },
    ])
    expect(there[0].losses).toEqual([
      { workspace: 'Ops', pane: 'db01', loss: 'remote' },
      { workspace: 'Ops', loss: 'canvas' },
      { workspace: 'Ops', loss: 'group', detail: 'Infra' },
    ])
  })

  it('keeps a group in this window, but not for a pinned workspace or when groups are off', () => {
    const on = planCmuxImport(recorded(), { existing: [], groups: true }).windows[0]
    const off = planCmuxImport(recorded(), { existing: [], groups: false }).windows[0]

    expect(on[4].group).toBe('Acme')
    expect(off[4].group).toBeUndefined()
    expect(off[4].losses).toContainEqual({ workspace: 'Research', loss: 'group', detail: 'Acme' })
  })

  it('skips a workspace already here with the same name and folder', () => {
    const plan = planCmuxImport(recorded(), {
      existing: [
        { name: 'App', workDir: `${APP}/`, saved: true },
        { name: 'Research', workDir: '/elsewhere', saved: true },
      ],
      groups: true,
    })

    expect(plan.skipped).toEqual([{ name: 'App', reason: 'exists', window: 0 }])
    expect(plan.windows[0].map((p) => p.name)).toEqual([
      'Office',
      'Client work',
      'Editor',
      'Research',
    ])
  })

  it('stops at the saved workspace limit and says which ones did not fit', () => {
    const existing = Array.from({ length: MAX_WORKSPACES - 2 }, (_, i) => ({
      name: `w${i}`,
      workDir: '/tmp',
      saved: true,
    }))
    const scratch = { name: 'scratch', workDir: '/tmp/s', saved: false }
    const plan = planCmuxImport(recorded(), { existing: [...existing, scratch], groups: true })

    expect(plan.windows.flat().map((p) => p.name)).toEqual(['Office', 'App'])
    expect(plan.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['Client work', 'limit'],
      ['Editor', 'limit'],
      ['Research', 'limit'],
      ['Ops', 'limit'],
    ])
  })

  it('opens a default terminal for a workspace with nothing Ostia can show', () => {
    const plan = planCmuxImport(
      oneWorkspace({ type: 'pane', surfaces: [{ type: 'simulator' }], selected: 0 }),
      { existing: [], groups: true },
    )
    const [big] = plan.windows[0]

    expect(big.workspace.root && strip(big.workspace.root)).toEqual({
      type: 'pane',
      title: 'Terminal',
      kind: 'terminal',
      cwd: '/home/u/big',
      defaultTitle: true,
    })
    expect(big.losses).toEqual([
      { workspace: 'Big', pane: 'simulator', loss: 'surface', detail: 'simulator' },
    ])
  })

  it('keeps no more panes than a saved workspace holds and reports the rest', () => {
    const plan = planCmuxImport(
      oneWorkspace({ type: 'pane', surfaces: terminals(MAX_PANES + 6), selected: 0 }),
      { existing: [], groups: true },
    )
    const [big] = plan.windows[0]

    expect(big.panes).toBe(MAX_PANES)
    expect(big.losses).toEqual([{ workspace: 'Big', loss: 'panes', detail: '6' }])
  })

  it('flattens splits nested deeper than a saved layout allows into tabs', () => {
    let layout: CmuxLayout = {
      type: 'pane',
      surfaces: terminals(1),
      selected: 0,
    }
    for (let i = 0; i < 20; i++) {
      layout = {
        type: 'split',
        direction: i % 2 ? 'vertical' : 'horizontal',
        divider: 0.5,
        first: { type: 'pane', surfaces: [{ type: 'terminal', title: `s${i}` }], selected: 0 },
        second: layout,
      }
    }
    const [big] = planCmuxImport(oneWorkspace(layout), { existing: [], groups: true }).windows[0]
    if (!big.workspace.root) throw new Error('no layout')

    expect(depthOf(big.workspace.root)).toBeLessThanOrEqual(MAX_LAYOUT_DEPTH)
    expect(snapshotPanes(big.workspace.root)).toHaveLength(21)
    expect(new Set(snapshotPanes(big.workspace.root)).size).toBe(21)
    expect(big.losses).toEqual([{ workspace: 'Big', loss: 'layout' }])
  })
})

describe('runCmuxImport', () => {
  it('creates the workspaces here, opens a window for cmux’s second one, and reports', async () => {
    serveSession()

    const report = await runCmuxImport({ callerWorkspaceId: null, remote: false })

    expect(names()).toEqual(['App', 'Office', 'Client work', 'Editor', 'Research'])
    const store = useWorkspacesStore.getState()
    const research = store.workspaces.find((w) => w.customName === 'Research')
    expect(store.groups.find((g) => g.id === research?.groupId)?.name).toBe('Acme')
    const office = store.workspaces.find((w) => w.customName === 'Office')
    expect(store.activeWorkspaceId).toBe(office?.id)
    const app = store.workspaces.find((w) => w.customName === 'App')
    expect(app?.pinned).toBe(true)
    const layout = app ? useLayoutStore.getState().byWorkspace[app.id] : undefined
    expect(layout && paneIds(layout.root)).toHaveLength(6)

    const opened = vi.mocked(window.ostia.windows.openWith).mock.calls
    expect(opened).toHaveLength(1)
    expect(opened[0][0].map((w) => w.customName)).toEqual(['Ops'])

    expect(report.path).toBe(SESSION_PATH)
    expect(report.imported.map((w) => [w.name, w.panes, w.window])).toEqual([
      ['Office', 2, 0],
      ['App', 6, 0],
      ['Client work', 3, 0],
      ['Editor', 1, 0],
      ['Research', 2, 0],
      ['Ops', 2, 1],
    ])
    expect(report.skipped).toEqual([])
    expect(report.notCarried).toContainEqual({ workspace: 'Ops', loss: 'canvas' })
    expect(useCmuxImportStore.getState().outcome).toEqual({ report })
  })

  it('creates nothing the second time', async () => {
    serveSession()
    const first = await runCmuxImport({ callerWorkspaceId: null, remote: false })
    const ops = first.imported.find((w) => w.name === 'Ops')
    const otherWindow: WindowSummary = {
      windowId: '2',
      detached: true,
      workspaces: [
        {
          id: ops?.workspaceId ?? '',
          name: 'Ops',
          workDir: '/Users/alex/Code/home/infra',
          state: 'idle',
          unreadAt: 0,
          panes: [],
        },
      ],
    }
    useWindowsStore.setState({ list: [otherWindow] })
    const before = useWorkspacesStore.getState().workspaces

    const second = await runCmuxImport({ callerWorkspaceId: null, remote: false })

    expect(useWorkspacesStore.getState().workspaces).toEqual(before)
    expect(vi.mocked(window.ostia.windows.openWith)).toHaveBeenCalledTimes(1)
    expect(second.imported).toEqual([])
    expect(second.notCarried).toEqual([])
    expect(second.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['Office', 'exists'],
      ['App', 'exists'],
      ['Client work', 'exists'],
      ['Editor', 'exists'],
      ['Research', 'exists'],
      ['Ops', 'exists'],
    ])
  })

  it('reports the workspaces of a window that did not open as skipped', async () => {
    serveSession()
    vi.mocked(window.ostia.windows.openWith).mockResolvedValue(false)

    const report = await runCmuxImport({ callerWorkspaceId: null, remote: false })

    expect(report.skipped).toEqual([{ name: 'Ops', reason: 'window', window: 1 }])
    expect(report.imported.map((w) => w.name)).not.toContain('Ops')
    expect(report.notCarried.map((l) => l.workspace)).not.toContain('Ops')
  })

  it('shows why nothing was imported when the session file is missing', async () => {
    vi.mocked(window.ostia.workspace.readCmux).mockResolvedValue({
      ok: false,
      error: 'not-found',
      path: SESSION_PATH,
    })

    await expect(runCmuxImport({ callerWorkspaceId: null, remote: false })).rejects.toBeInstanceOf(
      CmuxImportError,
    )
    expect(useCmuxImportStore.getState().outcome).toEqual({
      error: 'not-found',
      path: SESSION_PATH,
    })
    expect(useWorkspacesStore.getState().workspaces).toEqual([])
  })

  it('answers a CLI caller without opening the dialog', async () => {
    serveSession()

    const report: CmuxImportReport = await runCmuxImport({ callerWorkspaceId: 'w9', remote: true })

    expect(report.imported).toHaveLength(6)
    expect(useCmuxImportStore.getState().outcome).toBeNull()
  })

  it('refuses a caller in a sandboxed workspace before reading anything', async () => {
    serveSession()
    useSandboxStore.setState({ enabled: { w9: true } })

    await expect(runCmuxImport({ callerWorkspaceId: 'w9', remote: true })).rejects.toThrow(
      /^sandboxed:/,
    )
    expect(window.ostia.workspace.readCmux).not.toHaveBeenCalled()
  })
})

describe('workspace.importCmux', () => {
  it('passes an absolute session path through and refuses a relative one', async () => {
    serveSession()

    const bad = await commands.exec('workspace.importCmux', { path: 'session.json' })
    const good = await commands.exec('workspace.importCmux', { path: SESSION_PATH })

    expect(bad).toMatchObject({ ok: false, error: { message: 'path must be an absolute path' } })
    expect(good.ok).toBe(true)
    expect(window.ostia.workspace.readCmux).toHaveBeenCalledTimes(1)
    expect(window.ostia.workspace.readCmux).toHaveBeenCalledWith(SESSION_PATH)
  })

  it('reads cmux’s own session file when no path is given', async () => {
    serveSession()

    await commands.exec('workspace.importCmux')

    expect(window.ostia.workspace.readCmux).toHaveBeenCalledWith(undefined)
  })
})
