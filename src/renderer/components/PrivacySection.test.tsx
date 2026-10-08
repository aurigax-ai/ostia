import '@testing-library/jest-dom/vitest'
import { en } from '@shared/dict'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { DEFAULT_TELEMETRY_SETTINGS, TELEMETRY_CATEGORIES } from '@shared/telemetry'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../test/render'
import { useSettingsStore } from '../stores/settingsStore'
import { useTelemetryConsentStore } from '../stores/telemetryConsentStore'
import { PrivacySection } from './PrivacySection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const redaction = () => useSettingsStore.getState().privacy.redaction

describe('PrivacySection', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.privacy.kinds).mockResolvedValue([
      { kind: 'github', source: 'library', detects: ['GITHUB_TOKEN'] },
      { kind: 'aws', source: 'library', detects: ['AWSSecretAccessKey', 'AWSAccessKeyID'] },
      { kind: 'jwt', source: 'ostia', detects: [] },
      { kind: 'assignment', source: 'ostia', detects: [] },
    ])
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    vi.mocked(window.ostia.fs.write).mockClear()
    vi.mocked(window.ostia.privacy.preview).mockReset()
    vi.mocked(window.ostia.privacy.preview).mockImplementation(async (text) => ({
      text,
      count: 0,
      kinds: {},
    }))
  })

  it('is on by default and saves the switch at once when the human turns it off', async () => {
    render(<PrivacySection />)
    const toggle = screen.getByRole('switch', { name: 'Redact secrets' })
    expect(toggle).toBeChecked()

    await userEvent.click(toggle)

    expect(redaction().enabled).toBe(false)
    const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
    expect(written.privacy.redaction.enabled).toBe(false)
  })

  it('lists the kinds main reports from the library, then its own and the custom kind', async () => {
    render(<PrivacySection />)
    const library = await screen.findByRole('list', { name: 'From the secretlint rules' })
    await waitFor(() => expect(within(library).getAllByRole('listitem')).toHaveLength(2))
    expect(within(library).getByText('github')).toBeInTheDocument()
    expect(within(library).getByText('aws')).toHaveAttribute(
      'title',
      'AWSSecretAccessKey, AWSAccessKeyID',
    )
    const own = screen.getByRole('list', { name: `Added by ${PRODUCT_DISPLAY_NAME}` })
    expect(
      within(own)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'jwtJSON Web Tokens',
      'assignmentThe value given to a name containing password, secret, token or api_key',
      'customMatches of your own patterns',
    ])
  })

  it('adds a pattern, shows it, and removes it', async () => {
    render(<PrivacySection />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Pattern'), 'ACME-[[0-9]{{4}')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(redaction().patterns).toEqual(['ACME-[0-9]{4}'])
    expect(screen.getByLabelText('Pattern')).toHaveValue('')
    const list = screen.getByRole('list', { name: 'Your patterns' })
    expect(within(list).getByText('ACME-[0-9]{4}')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove ACME-[0-9]{4}' }))
    expect(redaction().patterns).toEqual([])
    expect(screen.getByText('No patterns yet.')).toBeInTheDocument()
  })

  it('refuses a pattern that could take very long, with the reason, and saves nothing', async () => {
    render(<PrivacySection />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Pattern'), '(a+)+b')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(redaction().patterns).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A repeated group cannot itself contain a repeat or an alternative.',
    )
    expect(screen.getByLabelText('Pattern')).toHaveAttribute('aria-invalid', 'true')
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
  })

  it('marks a hand-edited invalid pattern as ignored', async () => {
    useSettingsStore.setState({
      privacy: {
        redaction: { enabled: true, patterns: ['ok-[0-9]{2}', 'ACME-['] },
        telemetry: DEFAULT_TELEMETRY_SETTINGS,
      },
    })
    await renderSettled(<PrivacySection />)
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('Ignored. This is not a valid regular expression.')
  })

  it('shows what would be redacted in pasted text, by asking main', async () => {
    vi.mocked(window.ostia.privacy.preview).mockResolvedValue({
      text: 'export T=[redacted:github] [redacted:github]',
      count: 2,
      kinds: { github: 2 },
    })
    render(<PrivacySection />)
    await userEvent.type(screen.getByLabelText('Text to check'), 'export T=ghp_x ghp_y')

    expect(await screen.findByLabelText('After redaction')).toHaveTextContent(
      'export T=[redacted:github] [redacted:github]',
    )
    expect(screen.getByText('2 secrets redacted')).toBeInTheDocument()
    expect(screen.getByText('[redacted:github] × 2')).toBeInTheDocument()
    expect(vi.mocked(window.ostia.privacy.preview).mock.calls.at(-1)?.[0]).toBe(
      'export T=ghp_x ghp_y',
    )
  })

  it('says so when the pasted text holds nothing to redact', async () => {
    render(<PrivacySection />)
    await userEvent.type(screen.getByLabelText('Text to check'), 'git status')
    expect(await screen.findByText('Nothing would be redacted.')).toBeInTheDocument()
  })

  it('shows one switch per category, off, saves one at once, and resets the install id', async () => {
    const user = userEvent.setup()
    await renderSettled(<PrivacySection />)
    const labels = TELEMETRY_CATEGORIES.map((c) => en.privacy.categories[c].label)
    for (const label of labels)
      expect(screen.getByRole('switch', { name: label })).not.toBeChecked()
    expect(screen.getByText(/Install context/)).toBeInTheDocument()
    expect(screen.getByLabelText('Install id')).toHaveTextContent('install-id')

    await user.click(screen.getByRole('switch', { name: 'Terminal engine and performance' }))
    expect(useSettingsStore.getState().privacy.telemetry).toEqual({
      ...DEFAULT_TELEMETRY_SETTINGS,
      terminal: true,
    })
    const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
    expect(written.privacy.telemetry.terminal).toBe(true)
    expect(written.privacy.telemetry.errors).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Reset install id' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Install id')).toHaveTextContent('new-install-id'),
    )
    expect(window.ostia.telemetry.resetInstallId).toHaveBeenCalled()
  })

  it('marks a category added since the consent as new until the page is visited', async () => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValueOnce({
      installId: 'install-id',
      asked: true,
      available: true,
      newCategories: ['agents'],
    })
    await renderSettled(<PrivacySection />)
    const row = screen
      .getByRole('switch', { name: 'AI agent usage' })
      .closest('[data-settings-row]')
    expect(row).toHaveTextContent('New')
    expect(screen.queryAllByText('New')).toHaveLength(1)
    expect(window.ostia.telemetry.categoriesSeen).toHaveBeenCalled()
  })

  it('Review consent again opens the dialog pre-filled with the current switches', async () => {
    useSettingsStore.setState({
      privacy: {
        redaction: { enabled: true, patterns: [] },
        telemetry: { ...DEFAULT_TELEMETRY_SETTINGS, features: true },
      },
    })
    const user = userEvent.setup()
    await renderSettled(<PrivacySection />)
    await user.click(screen.getByRole('button', { name: 'Review consent again' }))
    expect(useTelemetryConsentStore.getState().open).toBe(true)
    expect(useTelemetryConsentStore.getState().initial.features).toBe(true)
    expect(useTelemetryConsentStore.getState().initial.errors).toBe(false)
  })

  it('offers no switches in a build without an endpoint, and says so', async () => {
    vi.mocked(window.ostia.telemetry.state).mockResolvedValueOnce({
      installId: 'install-id',
      asked: true,
      available: false,
      newCategories: [],
    })
    await renderSettled(<PrivacySection />)
    await screen.findByText(/This build has no telemetry endpoint/)
    expect(
      screen.queryByRole('switch', { name: 'Crash and error reports' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset install id' })).not.toBeInTheDocument()
  })

  it('shows the queued and last-sent reports read-only, filtered by category', async () => {
    vi.mocked(window.ostia.telemetry.reports).mockResolvedValue({
      queued: [
        {
          uuid: 'e1',
          event: '$exception',
          distinct_id: 'install-id',
          timestamp: '2026-10-07T00:00:00.000Z',
          properties: {
            app_version: '1.0.0',
            electron_version: '33',
            os_name: 'linux',
            os_version: '6',
            arch: 'x64',
            locale: 'en',
            channel: 'packaged',
            $process_person_profile: false,
            source: 'main-exception',
            $exception_list: [{ type: 'TypeError', value: 'boom', mechanism: { handled: true } }],
          },
        },
        {
          uuid: 'u1',
          event: 'usage',
          distinct_id: 'install-id',
          timestamp: '2026-10-07T00:00:00.000Z',
          properties: {
            app_version: '1.0.0',
            electron_version: '33',
            os_name: 'linux',
            os_version: '6',
            arch: 'x64',
            locale: 'en',
            channel: 'packaged',
            $process_person_profile: false,
            'agents.bus_message': 3,
          },
        },
      ],
      sent: [],
    })
    const user = userEvent.setup()
    await renderSettled(<PrivacySection />)
    await user.click(
      screen.getByRole('button', { name: `Show what ${PRODUCT_DISPLAY_NAME} sends` }),
    )
    const dialog = await screen.findByTestId('telemetry-reports-dialog')
    const queued = within(dialog).getByRole('region', { name: 'Waiting to be sent' })
    await waitFor(() => expect(queued).toHaveTextContent('"value": "boom"'))
    expect(queued).toHaveTextContent('agents.bus_message')
    expect(within(dialog).getByRole('region', { name: 'Last sent' })).toHaveTextContent('Nothing.')
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'AI agent usage' }))
    await waitFor(() => expect(queued).not.toHaveTextContent('"value": "boom"'))
    expect(queued).toHaveTextContent('agents.bus_message')
  })
})
