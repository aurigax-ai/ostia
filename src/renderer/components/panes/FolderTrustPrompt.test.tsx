import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeTrustGate } from '@/lib/agents/folderTrust'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { FolderTrustPrompt } from './ResumePrompts'

const layout = useLayoutStore.getState()

afterEach(() => {
  cleanup()
  useFolderTrustStore.setState({ byPane: {} })
  useLayoutStore.setState(layout, true)
})

describe('FolderTrustPrompt', () => {
  it('CFT-C15 names the folder and offers Trust folder, Let Claude ask and the always choice in its menu', async () => {
    render(<FolderTrustPrompt paneId="p1" folder="/home/u/Work/repo" />)
    const card = screen.getByRole('region', { name: 'Claude folder trust' })
    expect(card).toHaveTextContent('Trust repo for Claude?')
    expect(card).toHaveTextContent('/home/u/Work/repo')
    expect(card).toHaveTextContent('Claude asks before it works in a new folder.')
    for (const name of ['Trust folder', 'Let Claude ask']) {
      expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0)
    }
    expect(screen.queryByRole('menuitem')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'More ways to trust' }))
    expect(
      await screen.findByRole('menuitem', { name: 'Always trust my workspace folders' }),
    ).toBeInTheDocument()
  })

  it('the close button resumes without trusting, like Let Claude ask', async () => {
    vi.mocked(window.ostia.agentSession.folderTrust).mockResolvedValueOnce({
      state: 'ask',
      folder: '/home/u/Work/repo',
    })
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: { type: 'pane', id: 'p1', title: 'claude', kind: 'terminal' },
          activePaneId: 'p1',
          zoomedPaneId: null,
        },
      },
    })
    const gate = claudeTrustGate('p1', 'claude')
    await vi.waitFor(() => expect(useFolderTrustStore.getState().byPane.p1).toBeDefined())
    render(<FolderTrustPrompt paneId="p1" folder="/home/u/Work/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume without trusting; Claude asks' }))
    expect(await gate).toBe(true)
    expect(window.ostia.agentSession.trustFolder).not.toHaveBeenCalled()
  })

  it('CFT-C16 Trust folder asks main to trust that pane’s folder and lets the resume go on', async () => {
    vi.mocked(window.ostia.agentSession.folderTrust).mockResolvedValueOnce({
      state: 'ask',
      folder: '/home/u/Work/repo',
    })
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: { type: 'pane', id: 'p1', title: 'claude', kind: 'terminal' },
          activePaneId: 'p1',
          zoomedPaneId: null,
        },
      },
    })
    const gate = claudeTrustGate('p1', 'claude')
    await vi.waitFor(() => expect(useFolderTrustStore.getState().byPane.p1).toBeDefined())
    render(<FolderTrustPrompt paneId="p1" folder="/home/u/Work/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Trust folder' }))
    expect(await gate).toBe(true)
    expect(window.ostia.agentSession.trustFolder).toHaveBeenCalledWith('p1', '/home/u/Work/repo')
  })
})
