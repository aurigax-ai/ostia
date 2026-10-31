import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { RailCard } from './RailCard'

const ws = (id: string, name: string, state: Workspace['state'] = 'idle'): Workspace => ({
  id,
  name,
  kind: 'terminal',
  workDir: `/work/${name}`,
  state,
})

const members = [ws('a', 'alpha', 'waiting'), ws('b', 'beta', 'working'), ws('c', 'gamma')]

function show() {
  useWorkspacesStore.setState({ workspaces: members, activeWorkspaceId: 'c' })
  return render(
    <TooltipProvider>
      <RailCard title="Finops" members={members} pressOpens>
        <button type="button">open</button>
      </RailCard>
    </TooltipProvider>,
  )
}

beforeEach(() => useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null }))
afterEach(cleanup)

describe('RailCard', () => {
  it('opens on click with the group name, its state counts and one row per member', async () => {
    show()
    await userEvent.setup().click(screen.getByRole('button', { name: 'open' }))
    expect(await screen.findByText('Finops')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '1 need you' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '1 working' })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-card-row]')).toHaveLength(3)
  })

  it('moves focus with Down and Up and wraps at the ends', async () => {
    show()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByText('Finops')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-card-row]')]
    act(() => rows[0].focus())
    await user.keyboard('{ArrowDown}')
    expect(rows[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(rows[2]).toHaveFocus()
  })

  it('selects the workspace on Enter and closes', async () => {
    show()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByText('Finops')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-card-row]')]
    act(() => rows[1].focus())
    await user.keyboard('{Enter}')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('b')
    await waitFor(() => expect(screen.queryByText('Finops')).toBeNull())
  })

  it('selects the workspace on click and closes', async () => {
    show()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open' }))
    await user.click(await screen.findByRole('button', { name: /alpha/ }))
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('a')
    await waitFor(() => expect(screen.queryByText('Finops')).toBeNull())
  })

  it('closes on Escape', async () => {
    show()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByText('Finops')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Finops')).toBeNull())
  })

  it('opens the normal row menu on right-click of a row', async () => {
    show()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open' }))
    await user.pointer({
      keys: '[MouseRight]',
      target: await screen.findByRole('button', { name: /beta/ }),
    })
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
  })
})
