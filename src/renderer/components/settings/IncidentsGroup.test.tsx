import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIncidentReportStore } from '@/stores/agents/incidentReportStore'
import { IncidentsGroup } from './IncidentsGroup'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const incident = {
  ref: 'pane-1',
  trigger: 'not-submitted',
  agent: 'claude',
  ageMs: 12 * 60_000,
  events: 5,
}

describe('IncidentsGroup', () => {
  afterEach(() => {
    cleanup()
    useIncidentReportStore.getState().close()
    vi.mocked(window.ostia.incidents.list).mockResolvedValue([])
    vi.mocked(window.ostia.incidents.clear).mockClear()
  })

  it('says there are none when nothing was recorded', async () => {
    render(<IncidentsGroup />)
    expect(await screen.findByText('No incidents in the last few minutes.')).toBeInTheDocument()
  })

  it('lists an incident and opens its report on Report…', async () => {
    vi.mocked(window.ostia.incidents.list).mockResolvedValue([incident])
    render(<IncidentsGroup />)
    expect(await screen.findByText('Enter was not submitted')).toBeInTheDocument()
    expect(screen.getByText('claude · 12 min ago')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Report…' }))
    expect(useIncidentReportStore.getState().ref).toBe('pane-1')
  })

  it('clears only after the human confirms', async () => {
    vi.mocked(window.ostia.incidents.list).mockResolvedValue([incident])
    render(<IncidentsGroup />)
    await screen.findByText('Enter was not submitted')
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear…' })[0])
    expect(window.ostia.incidents.clear).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(window.ostia.incidents.clear).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('Enter was not submitted')).toBeNull())
  })

  it('names a refused agent run and undelivered mail, not a generic problem', async () => {
    vi.mocked(window.ostia.incidents.list).mockResolvedValue([
      { ...incident, ref: 'a', trigger: 'folder-not-trusted' },
      { ...incident, ref: 'b', trigger: 'undelivered-hooks-off' },
    ])
    render(<IncidentsGroup />)
    expect(await screen.findByText('Agent run refused: folder not trusted')).toBeInTheDocument()
    expect(screen.getByText('Mail not delivered: hooks are off')).toBeInTheDocument()
  })
})
