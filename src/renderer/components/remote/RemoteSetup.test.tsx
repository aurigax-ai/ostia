import '@testing-library/jest-dom/vitest'
import type { RemoteJob, SetupStep } from '@shared/remote/remoteSetup'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobsList } from './JobsList'
import { RemoteSetup } from './RemoteSetup'

afterEach(cleanup)

const step = (
  id: SetupStep['id'],
  state: SetupStep['state'],
  extra: Partial<SetupStep> = {},
): SetupStep => ({
  id,
  state,
  ...extra,
})

describe('RemoteSetup', () => {
  it('REM-D1 shows a failed step with its reason and a Retry that runs again', async () => {
    const onRetry = vi.fn()
    render(
      <RemoteSetup
        steps={[
          step('connect', 'done'),
          step('tools', 'failed', { error: 'node-missing' }),
          step('install', 'todo'),
        ]}
        onRetry={onRetry}
        onCheck={vi.fn()}
      />,
    )
    expect(screen.getByText(/node 20 or newer is not installed/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('REM-D2 shows a waiting sign-in as Waiting for you with Check again, never as Done', async () => {
    const onCheck = vi.fn()
    render(<RemoteSetup steps={[step('signin', 'waiting')]} onRetry={vi.fn()} onCheck={onCheck} />)
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.queryByText('Done')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(onCheck).toHaveBeenCalledOnce()
  })
})

describe('JobsList', () => {
  const jobs: RemoteJob[] = [
    { pane: 'a1', agent: 'claude', folder: '~/work', state: 'working', startedAt: '' },
    { pane: 'b2', agent: 'shell', folder: '~/work', state: 'exited', startedAt: '' },
  ]

  it('REM-D3 lists each job with its state and opens or stops it; an exited job cannot be stopped again', async () => {
    const onOpen = vi.fn()
    const onStop = vi.fn()
    render(<JobsList jobs={jobs} onOpen={onOpen} onStop={onStop} />)
    expect(screen.getByText('Working')).toBeInTheDocument()
    const [open] = screen.getAllByRole('button', { name: 'Open' })
    await userEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith('a1')
    const stops = screen.getAllByRole('button', { name: 'Stop' })
    await userEvent.click(stops[0])
    expect(onStop).toHaveBeenCalledWith('a1')
    expect(stops[1]).toBeDisabled()
  })

  it('REM-D4 says when nothing runs', () => {
    render(<JobsList jobs={[]} onOpen={vi.fn()} onStop={vi.fn()} />)
    expect(screen.getByText('Nothing runs on this host.')).toBeInTheDocument()
  })
})
