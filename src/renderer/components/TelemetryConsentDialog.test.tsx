import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../test/render'
import { useSettingsStore } from '../stores/settingsStore'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const telemetry = () => useSettingsStore.getState().privacy.telemetry

describe('TelemetryConsentDialog', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue({
      installId: 'i',
      asked: false,
      available: true,
    })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    vi.mocked(window.ostia.fs.write).mockClear()
    vi.mocked(window.ostia.telemetry.consented).mockClear()
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue({
      installId: 'i',
      asked: true,
      available: true,
    })
  })

  it('stays closed once the human has answered', async () => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue({
      installId: 'i',
      asked: true,
      available: true,
    })
    await renderSettled(<TelemetryConsentDialog />)
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
  })

  it('never asks in a build without an endpoint', async () => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue({
      installId: 'i',
      asked: false,
      available: false,
    })
    await renderSettled(<TelemetryConsentDialog />)
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
    expect(window.ostia.telemetry.consented).not.toHaveBeenCalled()
  })

  it('asks once, says what is and is not sent, and Share turns on the checked switches', async () => {
    const user = userEvent.setup()
    await renderSettled(<TelemetryConsentDialog />)
    const dialog = await screen.findByTestId('telemetry-consent-dialog')
    expect(dialog).toHaveTextContent('What is sent')
    expect(dialog).toHaveTextContent('What is never sent')
    expect(dialog).toHaveTextContent('Where it goes')
    expect(screen.getByRole('checkbox', { name: /Error reports/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Usage data/ })).toBeChecked()

    await user.click(screen.getByRole('checkbox', { name: /Usage data/ }))
    await user.click(screen.getByRole('button', { name: 'Share' }))

    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalled())
    expect(telemetry()).toEqual({ errors: true, usage: false })
    const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
    expect(written.privacy.telemetry).toEqual({ errors: true, usage: false })
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
  })

  it('Don’t share leaves both off and still counts as answered', async () => {
    const user = userEvent.setup()
    await renderSettled(<TelemetryConsentDialog />)
    await screen.findByTestId('telemetry-consent-dialog')
    await user.click(screen.getByRole('button', { name: 'Don’t share' }))

    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalled())
    expect(telemetry()).toEqual({ errors: false, usage: false })
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
  })

  it('closing the dialog with Escape means no', async () => {
    const user = userEvent.setup()
    await renderSettled(<TelemetryConsentDialog />)
    await screen.findByTestId('telemetry-consent-dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalled())
    expect(telemetry()).toEqual({ errors: false, usage: false })
  })
})
