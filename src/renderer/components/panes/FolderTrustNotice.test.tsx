import '@testing-library/jest-dom/vitest'
import { claudeTrustGate } from '@/lib/agents/folderTrust'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderTrustNotice } from './ResumeFolderNotice'

afterEach(() => {
  cleanup()
  useFolderTrustStore.setState({ byPane: {} })
})

describe('FolderTrustNotice', () => {
  it('CFT-C15 names the folder and offers the three choices inline', () => {
    render(<FolderTrustNotice paneId="p1" folder="/home/u/Work/repo" />)
    expect(screen.getByRole('region', { name: 'Claude folder trust' })).toHaveTextContent(
      'Claude will ask to trust this folder: /home/u/Work/repo',
    )
    for (const name of ['Trust for Claude', 'Always trust my workspace folders', 'Resume anyway']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('CFT-C16 Trust for Claude asks main to trust that pane’s folder and lets the resume go on', async () => {
    vi.mocked(window.ostia.agentSession.folderTrust).mockResolvedValueOnce({
      state: 'ask',
      folder: '/home/u/Work/repo',
    })
    const gate = claudeTrustGate('p1', 'claude')
    await vi.waitFor(() => expect(useFolderTrustStore.getState().byPane.p1).toBeDefined())
    render(<FolderTrustNotice paneId="p1" folder="/home/u/Work/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Trust for Claude' }))
    expect(await gate).toBe(true)
    expect(window.ostia.agentSession.trustFolder).toHaveBeenCalledWith('p1')
  })
})
