import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '@/commands/registry'
import * as forkConversation from '@/lib/agents/forkConversation'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import * as parkTab from '@/lib/park/parkTab'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { AgentActionsMenu } from './AgentActionsMenu'

const agent: PaneNode = {
  type: 'pane',
  id: 'p1',
  kind: 'terminal',
  title: 'export-tests',
  resume: { agent: 'claude', id: 's1', cwd: '/home/u/api' },
}

function seed(pane: PaneNode, kind: 'terminal' | 'scratch' = 'terminal'): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'a', kind, workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  const root: LayoutNode = { type: 'tabs', id: 't', activeId: pane.id, children: [pane] }
  useLayoutStore.setState({
    byWorkspace: { w1: { root, activePaneId: pane.id, zoomedPaneId: null } },
  })
}

function runAgent(): void {
  useBlocksStore.getState().promptStart('p1', { line: 0 }, null)
  useBlocksStore.getState().commandStart('p1', { line: 1 }, 'claude')
  useBlocksStore.getState().markAgent('p1', 'claude')
}

async function open(pane: PaneNode = agent) {
  const user = userEvent.setup()
  render(<AgentActionsMenu pane={pane} workspaceId="w1" />)
  const caret = screen.getByRole('button', { name: 'Agent actions' })
  await user.click(caret)
  return { user, caret }
}

describe('AgentActionsMenu', () => {
  beforeEach(() => {
    seed(agent)
    runAgent()
  })
  afterEach(() => {
    cleanup()
    useBlocksStore.setState(useBlocksStore.getInitialState(), true)
    useAttentionStore.setState({ byPane: {} })
    vi.restoreAllMocks()
  })

  it('lists Fork then Park, with no chord and no hint on an enabled item', async () => {
    await open()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['Fork', 'Park', 'Report this stall…'])
    expect(items[1]).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('forks from the Fork item', async () => {
    const fork = vi.spyOn(forkConversation, 'forkConversation').mockReturnValue('x')
    const { user } = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'Fork' }))
    expect(fork).toHaveBeenCalledWith('w1', 'p1')
  })

  it('parks once, at once, from the Park item', async () => {
    const park = vi.spyOn(parkTab, 'requestPark').mockResolvedValue()
    const { user } = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'Park' }))
    expect(park).toHaveBeenCalledTimes(1)
    expect(park).toHaveBeenCalledWith('w1', 'p1')
  })

  it('hides Fork when the pane has no session, and Park says why it cannot', async () => {
    const bare: PaneNode = { type: 'pane', id: 'p1', kind: 'terminal', title: 'claude' }
    seed(bare)
    const { user } = await open(bare)
    const items = await screen.findAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute('aria-disabled', 'true')
    expect(items[0]).toHaveTextContent('Park')
    expect(items[0]).not.toHaveTextContent('no agent is running in it')
    await user.keyboard('{ArrowDown}')
    expect(items[0]).toHaveFocus()
    expect(await screen.findByText('no agent is running in it')).toBeInTheDocument()
  })

  it.each([
    [
      'the agent works',
      () => useAttentionStore.getState().dispatch('p1', { type: 'set', state: 'working', at: 1 }),
      'the agent is working',
    ],
    ['the tab is locked', () => seed({ ...agent, locked: true }), 'the tab is locked'],
    [
      'the workspace is a scratch one',
      () => seed(agent, 'scratch'),
      'a scratch workspace keeps nothing',
    ],
  ])('disables Park with its reason when %s', async (_n, arrange, reason) => {
    arrange()
    const { user } = await open()
    const park = await screen.findByRole('menuitem', { name: /^Park/ })
    expect(park).toHaveAttribute('aria-disabled', 'true')
    expect(park).not.toHaveTextContent(reason)
    await user.hover(park)
    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(park).not.toHaveTextContent(/Ctrl|⌘|⌥/)
  })

  it('closes on Escape and gives the focus back to the caret', async () => {
    const { user, caret } = await open()
    await screen.findByRole('menuitem', { name: 'Fork' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(caret).toHaveFocus())
    expect(caret).toHaveAttribute('aria-expanded', 'false')
  })

  describe('Hand off', () => {
    let on = true
    beforeEach(() => {
      on = true
      commands.register({
        id: 'handoff.start',
        title: 'Hand off…',
        listed: () => on,
        run: () => {},
      })
    })
    afterEach(() => {
      commands.unregister('handoff.start')
    })

    it('sits between Fork and Park and asks for the topic in the palette', async () => {
      const openPalette = vi.spyOn(useUIStore.getState(), 'openPalette')
      const { user } = await open()
      const items = await screen.findAllByRole('menuitem')
      expect(items.map((i) => i.textContent)).toEqual([
        'Fork',
        'Hand off',
        'Park',
        'Report this stall…',
      ])
      await user.click(items[1])
      expect(openPalette).toHaveBeenCalledWith('search', 'Hand off…')
    })

    it('is not there while the playbook is off', async () => {
      on = false
      await open()
      const items = await screen.findAllByRole('menuitem')
      expect(items.map((i) => i.textContent)).toEqual(['Fork', 'Park', 'Report this stall…'])
    })

    it('is not there for a scratch workspace or a pane that is not a Claude session', async () => {
      seed(agent, 'scratch')
      await open()
      expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).not.toContain(
        'Hand off',
      )
      cleanup()
      seed(agent)
      await open({ ...agent, resume: { agent: 'codex', id: 's1', cwd: '/w' } })
      expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).not.toContain(
        'Hand off',
      )
    })
  })
})
