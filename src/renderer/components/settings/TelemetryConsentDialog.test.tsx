import '@testing-library/jest-dom/vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTelemetryConsentStore } from '@/stores/telemetryConsentStore'
import { DEFAULT_TELEMETRY_SETTINGS } from '@shared/telemetry'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const telemetry = () => useSettingsStore.getState().privacy.telemetry
const state = (asked: boolean, available = true) => ({
  installId: 'i',
  asked,
  available,
  newCategories: [],
})

describe('TelemetryConsentDialog', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue(state(false))
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useTelemetryConsentStore.setState({ open: false, initial: DEFAULT_TELEMETRY_SETTINGS })
    vi.mocked(window.ostia.fs.write).mockClear()
    vi.mocked(window.ostia.telemetry.consented).mockClear()
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue(state(true))
  })

  it('stays closed once the human has answered, and in a build without an endpoint', async () => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue(state(true))
    await renderSettled(<TelemetryConsentDialog />)
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
    cleanup()
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue(state(false, false))
    await renderSettled(<TelemetryConsentDialog />)
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
    expect(window.ostia.telemetry.consented).not.toHaveBeenCalled()
  })

  it('lists every category unchecked with its details, and Share stays disabled until one is ticked', async () => {
    const user = userEvent.setup()
    await renderSettled(<TelemetryConsentDialog />)
    const dialog = await screen.findByTestId('telemetry-consent-dialog')
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(6)
    for (const box of boxes) expect(box).not.toBeChecked()
    expect(dialog).toHaveTextContent('Install context')
    expect(dialog).toHaveTextContent('always included with anything you share')
    expect(screen.getByRole('button', { name: 'Share selected' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Show details: Crash and error reports' }))
    expect(dialog).toHaveTextContent('stack frames reduced to function and file names')

    await user.click(screen.getByRole('checkbox', { name: /Crash and error reports/ }))
    expect(screen.getByRole('button', { name: 'Share selected' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Share selected' }))

    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalled())
    expect(telemetry()).toEqual({ ...DEFAULT_TELEMETRY_SETTINGS, errors: true })
    const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
    expect(written.privacy.telemetry).toEqual({ ...DEFAULT_TELEMETRY_SETTINGS, errors: true })
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
  })

  it('Select all ticks every category', async () => {
    const user = userEvent.setup()
    await renderSettled(<TelemetryConsentDialog />)
    await screen.findByTestId('telemetry-consent-dialog')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Share selected' }))
    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalled())
    expect(Object.values(telemetry()).every(Boolean)).toBe(true)
  })

  it('Don’t share and Escape leave everything off and still count as answered', async () => {
    const user = userEvent.setup()
    await renderSettled(<TelemetryConsentDialog />)
    await screen.findByTestId('telemetry-consent-dialog')
    await user.click(screen.getByRole('checkbox', { name: /App usage/ }))
    await user.click(screen.getByRole('button', { name: 'Don’t share' }))
    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalledTimes(1))
    expect(telemetry()).toEqual(DEFAULT_TELEMETRY_SETTINGS)

    cleanup()
    await renderSettled(<TelemetryConsentDialog />)
    await screen.findByTestId('telemetry-consent-dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.ostia.telemetry.consented).toHaveBeenCalledTimes(2))
    expect(telemetry()).toEqual(DEFAULT_TELEMETRY_SETTINGS)
  })

  it('Review consent again reopens it pre-filled with the current switches', async () => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValue(state(true))
    await renderSettled(<TelemetryConsentDialog />)
    expect(screen.queryByTestId('telemetry-consent-dialog')).not.toBeInTheDocument()
    act(() => {
      useTelemetryConsentStore.getState().show({ ...DEFAULT_TELEMETRY_SETTINGS, agents: true })
    })
    await screen.findByTestId('telemetry-consent-dialog')
    expect(screen.getByRole('checkbox', { name: /AI agent usage/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /App usage/ })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Share selected' })).toBeEnabled()
  })
})
