import type { ExtensionConnectionEntry, ExtensionInfo } from '@shared/extensions'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'

const TOKEN = ['tok', 'y'.repeat(16)].join('-')

function graphs(): ExtensionInfo {
  return {
    id: 'graphs',
    name: 'Graphs',
    version: '1.0.0',
    description: '',
    builtin: true,
    enabled: true,
    status: 'running',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    iconThemes: [],
    keymaps: [],
    assist: [],
    secrets: [],
    secretsSet: [],
    connectionKinds: [
      {
        kind: 'http',
        title: 'HTTP API',
        fields: [
          { key: 'baseUrl', title: 'Base URL', type: 'string', required: true },
          {
            key: 'auth',
            title: 'Auth',
            type: 'enum',
            enum: ['none', 'bearer'],
            default: 'bearer',
          },
        ],
        secrets: [{ key: 'secret', title: 'Token', description: 'The bearer token' }],
      },
    ],
    settingsPage: null,
    category: 'tools',
    languages: [],
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
  }
}

const SAVED: ExtensionConnectionEntry = {
  name: 'api',
  kind: 'http',
  fields: { baseUrl: 'https://api.example.test', auth: 'bearer' },
  secretsSet: ['secret'],
}

describe('the Connections list', () => {
  afterEach(() => {
    vi.mocked(window.ostia.extensions.connections).mockReset().mockResolvedValue([])
    vi.mocked(window.ostia.extensions.saveConnection).mockReset()
    vi.mocked(window.ostia.extensions.removeConnection).mockReset()
  })

  it('adds a connection with its fields and a secret typed as a password', async () => {
    vi.mocked(window.ostia.extensions.connections).mockResolvedValue([])
    vi.mocked(window.ostia.extensions.saveConnection).mockResolvedValue({ ok: true })
    render(<ExtensionSettingsForm ext={graphs()} />)
    await screen.findByText('No connections yet.')
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    await userEvent.type(screen.getByLabelText('Name'), 'api')
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://api.example.test')
    const secret = screen.getByLabelText('Token')
    expect(secret).toHaveAttribute('type', 'password')
    await userEvent.type(secret, TOKEN)
    vi.mocked(window.ostia.extensions.connections).mockResolvedValue([SAVED])
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(window.ostia.extensions.saveConnection).toHaveBeenCalledWith('graphs', {
      name: 'api',
      kind: 'http',
      fields: { baseUrl: 'https://api.example.test', auth: 'bearer' },
      secrets: { secret: TOKEN },
    })
    await screen.findByText('api')
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull()
  })

  it('edits a saved connection without showing its secret, keeps it when left empty and clears it on request', async () => {
    vi.mocked(window.ostia.extensions.connections).mockResolvedValue([SAVED])
    vi.mocked(window.ostia.extensions.saveConnection).mockResolvedValue({ ok: true })
    render(<ExtensionSettingsForm ext={graphs()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Token')).toHaveValue('')
    expect(screen.getByText('Saved. Leave empty to keep it.')).toBeInTheDocument()
    const url = screen.getByLabelText('Base URL')
    await userEvent.clear(url)
    await userEvent.type(url, 'https://v2.example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(window.ostia.extensions.saveConnection).toHaveBeenLastCalledWith('graphs', {
      name: 'api',
      kind: 'http',
      fields: { baseUrl: 'https://v2.example.test', auth: 'bearer' },
      secrets: {},
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(window.ostia.extensions.saveConnection).toHaveBeenLastCalledWith(
      'graphs',
      expect.objectContaining({ secrets: { secret: null } }),
    )
  })

  it('removes a connection and shows why a save was refused', async () => {
    vi.mocked(window.ostia.extensions.connections).mockResolvedValue([SAVED])
    vi.mocked(window.ostia.extensions.removeConnection).mockResolvedValue({ ok: true })
    vi.mocked(window.ostia.extensions.saveConnection).mockResolvedValue({
      ok: false,
      error: 'invalid-name',
    })
    render(<ExtensionSettingsForm ext={graphs()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove api' }))
    expect(window.ostia.extensions.removeConnection).toHaveBeenCalledWith('graphs', 'api')
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Bad Name')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Not saved: invalid-name'),
    )
  })
})
