import type { ExtensionInfo } from '@shared/extensions'
import { PRODUCT_NAME } from '@shared/product'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'

function assistant(overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: 'assistant',
    name: 'Assistant',
    version: '0.1.0',
    description: '',
    builtin: true,
    enabled: true,
    status: 'running',
    requested: ['assist'],
    granted: ['assist'],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    iconThemes: [],
    assist: ['command', 'chat'],
    secrets: [{ key: 'apiKey', description: 'Key for the provider' }],
    secretsSet: [],
    category: 'other',
    languages: [],
    ...overrides,
  }
}

describe('ExtensionSettingsForm secrets', () => {
  afterEach(() => {
    useExtensionsStore.setState({ list: [] })
    useAssistStore.setState({ availability: {} })
    vi.mocked(window.pine.extensions.setSecret).mockReset()
  })

  it('saves a typed secret through main and never shows a stored value', async () => {
    const saved = assistant({ secretsSet: ['apiKey'] })
    vi.mocked(window.pine.extensions.setSecret).mockResolvedValue({ ok: true, list: [saved] })
    const { rerender } = render(<ExtensionSettingsForm ext={assistant()} />)
    expect(screen.getByText('Not set')).toBeInTheDocument()
    const field = screen.getByLabelText('Api key')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveValue('')
    await userEvent.type(field, 'sk-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(window.pine.extensions.setSecret).toHaveBeenCalledWith(
      'assistant',
      'apiKey',
      'sk-secret',
    )
    await waitFor(() => expect(field).toHaveValue(''))
    expect(useExtensionsStore.getState().list).toEqual([saved])
    rerender(<ExtensionSettingsForm ext={saved} />)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('sk-secret')).toBeNull()
  })

  it('clears a stored secret', async () => {
    vi.mocked(window.pine.extensions.setSecret).mockResolvedValue({
      ok: true,
      list: [assistant()],
    })
    render(<ExtensionSettingsForm ext={assistant({ secretsSet: ['apiKey'] })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(window.pine.extensions.setSecret).toHaveBeenCalledWith('assistant', 'apiKey', null)
  })

  it('shows the error main returns', async () => {
    vi.mocked(window.pine.extensions.setSecret).mockResolvedValue({
      ok: false,
      error: 'encryption-unavailable',
    })
    render(<ExtensionSettingsForm ext={assistant()} />)
    await userEvent.type(screen.getByLabelText('Api key'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('encryption-unavailable')
  })

  it('leaves out the settings it is told to omit', () => {
    const ext = assistant({
      settings: [
        { key: 'baseUrl', type: 'string', default: '', description: 'Address' },
        { key: 'chat', type: 'boolean', default: true, description: 'Chat switch' },
      ],
    })
    render(<ExtensionSettingsForm ext={ext} omit={['chat']} />)
    expect(screen.getByRole('textbox', { name: 'Base url' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Chat' })).toBeNull()
  })
})

describe('ExtensionSettingsForm labels', () => {
  afterEach(() => {
    useExtensionsStore.setState({ list: [] })
    vi.mocked(window.pine.extensions.setSetting).mockReset()
  })

  function ports(): ExtensionInfo {
    return assistant({
      id: 'ports',
      name: 'Ports',
      secrets: [],
      settings: [
        {
          key: 'intervalSeconds',
          type: 'number',
          title: 'Scan interval',
          default: 3,
          minimum: 1,
          maximum: 60,
          unit: 'seconds',
          description: 'Time between port scans while {product} is focused',
        },
        {
          key: 'portHost',
          type: 'enum',
          values: ['localhost', '127.0.0.1'],
          default: 'localhost',
          description: 'Host used to open a port',
        },
        {
          key: 'graphScope',
          type: 'enum',
          title: 'Graph branches',
          values: ['current', 'all'],
          valueTitles: { current: 'Current branch', all: 'All branches' },
          default: 'current',
          description: 'Branches the graph shows',
        },
      ],
      settingValues: { intervalSeconds: 3, portHost: 'localhost', graphScope: 'current' },
    })
  }

  it('labels a setting with its manifest title and keeps the raw key as a mono hint', () => {
    render(<ExtensionSettingsForm ext={ports()} />)
    expect(screen.getByRole('spinbutton', { name: 'Scan interval' })).toHaveValue(3)
    expect(screen.getByText('Scan interval')).toHaveClass('text-ui-base')
    expect(screen.getByText('intervalSeconds')).toHaveClass('font-mono', 'text-ui-xs')
    expect(screen.queryByRole('spinbutton', { name: 'intervalSeconds' })).toBeNull()
  })

  it('humanizes the key of a setting without a title', () => {
    render(<ExtensionSettingsForm ext={ports()} />)
    expect(screen.getByRole('combobox', { name: 'Port host' })).toHaveTextContent('localhost')
    expect(screen.getByText('portHost')).toBeInTheDocument()
  })

  it('fills in the product name and shows the range with its unit', () => {
    render(<ExtensionSettingsForm ext={ports()} />)
    expect(
      screen.getByText(
        `Time between port scans while ${PRODUCT_NAME} is focused (1 to 60 seconds)`,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/\{product\}/)).toBeNull()
  })

  it('shows enum value titles instead of raw values', () => {
    render(<ExtensionSettingsForm ext={ports()} />)
    expect(screen.getByRole('combobox', { name: 'Graph branches' })).toHaveTextContent(
      'Current branch',
    )
  })

  it('clamps a number to the manifest range before saving it', async () => {
    vi.mocked(window.pine.extensions.setSetting).mockResolvedValue({ ok: false, error: 'x' })
    render(<ExtensionSettingsForm ext={ports()} />)
    const input = screen.getByRole('spinbutton', { name: 'Scan interval' })
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '60')
    await userEvent.clear(input)
    await userEvent.type(input, '600{Enter}')
    expect(window.pine.extensions.setSetting).toHaveBeenCalledWith('ports', 'intervalSeconds', 60)
  })

  it('labels a secret with its title', () => {
    render(
      <ExtensionSettingsForm
        ext={assistant({ secrets: [{ key: 'apiKey', title: 'API key', description: 'Key' }] })}
      />,
    )
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password')
    expect(screen.getByText('apiKey')).toHaveClass('font-mono')
  })
})
