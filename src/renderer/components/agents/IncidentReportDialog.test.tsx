import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIncidentReportStore } from '@/stores/agents/incidentReportStore'
import { IncidentReportDialog } from './IncidentReportDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

describe('IncidentReportDialog', () => {
  afterEach(() => {
    cleanup()
    useIncidentReportStore.getState().close()
    vi.mocked(window.ostia.incidents.report).mockReset()
    vi.mocked(window.ostia.incidents.openIssue).mockReset()
  })

  it('stays closed until a pane is chosen', () => {
    render(<IncidentReportDialog />)
    expect(screen.queryByTestId('incident-report-dialog')).toBeNull()
  })

  it('shows the generated report, sends the human words and opens the issue only on click', async () => {
    vi.mocked(window.ostia.incidents.report).mockResolvedValue({
      text: '## Timeline\n+0.0s  pane.input start',
      redacted: 2,
    })
    useIncidentReportStore.getState().open('pane-1')
    render(<IncidentReportDialog />)
    expect(await screen.findByTestId('incident-report-text')).toHaveTextContent('pane.input start')
    expect(screen.getByText('2 secrets hidden in your words.')).toBeInTheDocument()
    expect(window.ostia.incidents.openIssue).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('What happened (your words)'), 'it hung')
    await waitFor(() =>
      expect(window.ostia.incidents.report).toHaveBeenLastCalledWith('pane-1', {
        happened: 'it hung',
        expected: '',
      }),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open new GitHub issue' }))
    expect(window.ostia.incidents.openIssue).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/copied to your clipboard/)).toBeInTheDocument()
  })

  it('says so and disables every action when the pane has no recorded calls', async () => {
    vi.mocked(window.ostia.incidents.report).mockResolvedValue(null)
    useIncidentReportStore.getState().open('pane-1')
    render(<IncidentReportDialog />)
    expect(await screen.findByText(/No recorded calls/)).toBeInTheDocument()
    for (const name of ['Copy', 'Save…', 'Open new GitHub issue']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })
})
