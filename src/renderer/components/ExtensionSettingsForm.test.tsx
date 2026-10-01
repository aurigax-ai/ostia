import type { ExtensionInfo } from '@shared/extensions'
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
    settings: [],
    settingValues: {},
    iconThemes: [],
    assist: ['command', 'chat'],
    secrets: [{ key: 'apiKey', description: 'Key for the provider' }],
    secretsSet: [],
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
    const field = screen.getByLabelText('apiKey')
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
    await userEvent.type(screen.getByLabelText('apiKey'), 'x')
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
    expect(screen.getByRole('textbox', { name: 'baseUrl' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'chat' })).toBeNull()
  })
})
