import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPane, findPane, tabsOf } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import type { CommandBlock } from '@/stores/terminal/blocksStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

const typed: [string, string][] = []

vi.mock('@/lib/terminal/blockActions', () => ({
  runWhenIdle: vi.fn(
    (
      paneId: string,
      command: string,
      _timeout: number | undefined,
      allowed: () => boolean | Promise<boolean>,
      onGiveUp: () => void = () => {},
      onTyped: () => void = () => {},
    ) => {
      const type = (ok: boolean): void => {
        if (ok) {
          typed.push([paneId, command])
          onTyped()
        } else {
          onGiveUp()
        }
      }
      const verdict = allowed()
      if (typeof verdict === 'boolean') type(verdict)
      else void verdict.then(type)
      return vi.fn()
    },
  ),
}))

const { RESUME_CLAIM_MS, clearResumeClaims, resumeConflict, resumeHolder, resumeWhenIdle } =
  await import('./resumeFolder')

const session = { agent: 'claude' as const, id: 'd27bd196' }
const own = { agent: 'claude' as const, id: '25f360be' }

function agentPane(title: string, extra: Partial<PaneNode> = {}): PaneNode {
  return { ...createPane('terminal'), title, resume: session, ...extra }
}

function seed(...panes: PaneNode[]): void {
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: tabsOf(panes[0].id, ...panes), activePaneId: panes[0].id, zoomedPaneId: null },
    },
  })
}

function hookAgent(command: string): 'claude' | 'codex' | null {
  const program = command.split(' ')[0]?.replaceAll("'", '')
  return program === 'claude' || program === 'codex' ? program : null
}

function start(paneId: string, command: string): void {
  const id = `${paneId}-b`
  const agent = hookAgent(command)
  useBlocksStore.setState((s) => ({
    running: { ...s.running, [paneId]: id },
    byPane: {
      ...s.byPane,
      [paneId]: [{ id, paneId, command, startedAt: 0 } as unknown as CommandBlock],
    },
    ...(agent ? { agentBlocks: { ...s.agentBlocks, [paneId]: { blockId: id, agent } } } : {}),
  }))
}

function end(paneId: string): void {
  useBlocksStore.setState((s) => ({ running: { ...s.running, [paneId]: undefined } }))
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const current = (pane: PaneNode): PaneNode =>
  findPane(useLayoutStore.getState().byWorkspace.w1.root, pane.id) ?? pane

describe('resume session conflicts', () => {
  const init = { layout: useLayoutStore.getState(), blocks: useBlocksStore.getState() }

  afterEach(() => {
    typed.length = 0
    clearResumeClaims()
    useLayoutStore.setState(init.layout, true)
    useBlocksStore.setState(init.blocks, true)
  })

  it('warns in both panes when two live agents run the same session', () => {
    const coordinator = agentPane('Ostia coordinator')
    const bugs = agentPane('Ostia small bugs')
    seed(coordinator, bugs)
    start(coordinator.id, `'claude' --resume ${session.id}`)
    start(bugs.id, `'claude' --resume ${session.id} --agent research`)

    expect(resumeConflict(bugs)?.id).toBe(coordinator.id)
    expect(resumeConflict(coordinator)?.id).toBe(bugs.id)
  })

  it('records the same session again in one pane without a warning', () => {
    const pane = agentPane('Ostia coordinator')
    seed(pane)
    start(pane.id, `'claude' --resume ${session.id}`)
    useLayoutStore.getState().setResume('w1', pane.id, session)
    useLayoutStore.getState().setResume('w1', pane.id, { ...session, cwd: '/w' })

    expect(resumeConflict(current(pane))).toBeNull()
    expect(resumeHolder(pane.id, session)).toBeNull()
  })

  it('lets another pane resume the session once the first agent has exited', async () => {
    const before = agentPane('old tab')
    const after = agentPane('new tab', { resumePending: true })
    seed(before, after)
    start(before.id, `'claude' --resume ${session.id}`)
    end(before.id)

    resumeWhenIdle(after.id, session)
    await settle()
    start(after.id, `'claude' --resume ${session.id}`)

    expect(typed).toEqual([[after.id, `'claude' --resume ${session.id}`]])
    expect(resumeConflict(after)).toBeNull()
    expect(resumeConflict(before)).toBeNull()
  })

  it('refuses to type a resume while the session runs in another pane and warns there', async () => {
    const coordinator = agentPane('Ostia coordinator')
    const stale = agentPane('Ostia small bugs', { resumePending: true })
    seed(coordinator, stale)
    start(coordinator.id, `'claude' --resume ${session.id}`)
    const gaveUp = vi.fn()

    resumeWhenIdle(stale.id, session, gaveUp)
    await settle()

    expect(typed).toEqual([])
    expect(gaveUp).toHaveBeenCalledWith(true)
    expect(resumeConflict(stale)?.title).toBe('Ostia coordinator')
  })

  it('stays quiet in an idle shell that only remembers the session', () => {
    const coordinator = agentPane('Ostia coordinator')
    const idle = agentPane('old tab')
    seed(coordinator, idle)
    start(coordinator.id, `'claude' --resume ${session.id}`)

    expect(resumeConflict(idle)).toBeNull()
    expect(resumeConflict(coordinator)).toBeNull()
  })

  it('warns in a hibernated pane whose session woke up elsewhere', () => {
    const coordinator = agentPane('Ostia coordinator')
    const asleep = agentPane('old tab', { hibernated: true })
    seed(coordinator, asleep)
    start(coordinator.id, `'claude' --resume ${session.id}`)

    expect(resumeConflict(asleep)?.id).toBe(coordinator.id)
  })

  it('resumes only one of two panes restored with the same session at the same time', async () => {
    const first = agentPane('first', { resumePending: true })
    const second = agentPane('second', { resumePending: true })
    const other = agentPane('other', { resumePending: true, resume: own })
    seed(first, second, other)

    resumeWhenIdle(first.id, session)
    resumeWhenIdle(second.id, session)
    resumeWhenIdle(other.id, own)
    await settle()

    expect(typed).toEqual([
      [first.id, `'claude' --resume ${session.id}`],
      [other.id, `'claude' --resume ${own.id}`],
    ])
    expect(resumeHolder(second.id, session)?.id).toBe(first.id)
  })

  it('releases a typed resume that never started an agent', async () => {
    const first = agentPane('first', { resumePending: true })
    const second = agentPane('second', { resumePending: true })
    seed(first, second)
    const now = Date.now()

    resumeWhenIdle(first.id, session)
    await settle()
    expect(resumeHolder(second.id, session, now)?.id).toBe(first.id)
    expect(resumeHolder(second.id, session, now + RESUME_CLAIM_MS + 1000)).toBeNull()

    resumeWhenIdle(first.id, session)
    await settle()
    start(first.id, 'ls')
    expect(resumeHolder(second.id, session)).toBeNull()
  })

  it('refuses a session that runs in another window and keeps the pane free', async () => {
    const pane = agentPane('restored', { resumePending: true })
    const other = agentPane('other')
    seed(pane, other)
    vi.mocked(window.ostia.agentSession.claimResume).mockResolvedValueOnce({
      ok: false,
      holder: 'coordinator',
    })
    const gaveUp = vi.fn()

    resumeWhenIdle(pane.id, session, gaveUp)
    await settle()

    expect(window.ostia.agentSession.claimResume).toHaveBeenCalledWith(pane.id, session)
    expect(typed).toEqual([])
    expect(gaveUp).toHaveBeenCalledWith(true)
    expect(resumeHolder(other.id, session)).toBeNull()
  })
})
