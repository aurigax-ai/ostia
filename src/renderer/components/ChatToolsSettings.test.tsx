import '@testing-library/jest-dom/vitest'
import type { McpServerSettings, McpServerStatus } from '@shared/chatTools'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetChatTools, useChatToolsStore } from '../stores/chatToolsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ChatToolsSettings } from './ChatToolsSettings'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const github: McpServerSettings = {
  name: 'github',
  enabled: true,
  command: ['npx', '-y', '@modelcontextprotocol/server-github'],
  env: {},
  secrets: ['GITHUB_TOKEN'],
  disabledTools: [],
}

function status(patch: Partial<McpServerStatus>): McpServerStatus {
  return { name: 'github', transport: 'stdio', state: 'idle', tools: [], secretsSet: [], ...patch }
}

function seed(servers: McpServerSettings[], skillFolders: string[] = []): void {
  useSettingsStore.setState((s) => ({
    assistant: { ...s.assistant, mcpServers: servers, skillFolders },
  }))
}

const servers = () => useSettingsStore.getState().assistant.mcpServers

describe('ChatToolsSettings', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    resetChatTools()
    vi.mocked(window.pine.chatTools.setMcpSecret).mockReset().mockResolvedValue({ ok: true })
    vi.mocked(window.pine.chatTools.mcpRefresh).mockReset().mockResolvedValue([])
    vi.mocked(window.pine.chatTools.skills).mockReset().mockResolvedValue([])
    vi.mocked(window.pine.sync.pickFolder).mockReset().mockResolvedValue(null)
  })

  it('shows short empty states with their add actions and the access rows', () => {
    render(<ChatToolsSettings />)
    expect(screen.getByText('Read the workspace')).toBeInTheDocument()
    expect(screen.getByText('Asks every time')).toBeInTheDocument()
    expect(screen.getByText('No MCP servers')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument()
    expect(screen.getByText('No skill folders')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeInTheDocument()
    expect(screen.queryByText(/LOGNAME|256 KiB|shell/)).toBeNull()
  })

  it('adds a command server with an env var and a secret through the dialog', async () => {
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await user.click(screen.getByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' })
    await user.type(within(dialog).getByLabelText('Name'), 'github')
    await user.type(within(dialog).getByLabelText('Command'), 'npx')
    await user.type(
      within(dialog).getByLabelText('Arguments'),
      '-y @modelcontextprotocol/server-github',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Add variable' }))
    await user.type(within(dialog).getByLabelText('Variable name'), 'GITHUB_HOST')
    await user.type(within(dialog).getByLabelText('Variable value'), 'github.com')
    await user.click(within(dialog).getByRole('button', { name: 'Add secret' }))
    await user.type(within(dialog).getByLabelText('Secret name'), 'GITHUB_TOKEN')
    await user.type(within(dialog).getByLabelText('Secret value'), 'ghp_secret')
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(servers()).toEqual([
      {
        name: 'github',
        enabled: true,
        command: ['npx', '-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_HOST: 'github.com' },
        secrets: ['GITHUB_TOKEN'],
        disabledTools: [],
      },
    ])
    expect(window.pine.chatTools.setMcpSecret).toHaveBeenCalledWith(
      'github',
      'GITHUB_TOKEN',
      'ghp_secret',
    )
    expect(JSON.stringify(useSettingsStore.getState().assistant)).not.toContain('ghp_secret')
    expect(screen.getByRole('list', { name: 'MCP servers' })).toHaveTextContent('github')
  })

  it('shows validation errors next to the fields and saves nothing', async () => {
    seed([github])
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await user.click(screen.getByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'github')
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }))
    await user.click(await screen.findByRole('option', { name: 'URL' }))
    await user.type(within(dialog).getByLabelText('URL'), 'ftp://nope')
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }))
    const alerts = within(dialog)
      .getAllByRole('alert')
      .map((a) => a.textContent)
    expect(alerts).toEqual([
      'Use letters, digits, - and _ (up to 32), not already used.',
      'Enter an http or https URL.',
    ])
    expect(within(dialog).getByLabelText('URL')).toHaveAttribute('aria-invalid', 'true')
    expect(servers()).toEqual([github])
  })

  it('renders real status: connected with tool count, error with its message, not connected', () => {
    seed([github, { ...github, name: 'broken' }, { ...github, name: 'idle' }])
    useChatToolsStore.setState({
      mcp: [
        status({
          state: 'ready',
          tools: [
            { name: 'search', description: 'Search code', inputSchema: {} },
            { name: 'issue', description: '', inputSchema: {} },
          ],
        }),
        status({ name: 'broken', state: 'error', error: 'spawn npx ENOENT' }),
      ],
    })
    render(<ChatToolsSettings />)
    const rows = within(screen.getByRole('list', { name: 'MCP servers' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Connected · 2 tools')
    expect(rows[1]).toHaveTextContent('Error')
    expect(within(rows[1]).getByRole('alert')).toHaveTextContent('spawn npx ENOENT')
    expect(within(rows[1]).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    expect(rows[2]).toHaveTextContent('Not connected')
    expect(within(rows[2]).getByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  it('switches a tool off from the expanded tools list', async () => {
    seed([github])
    const live = [
      status({
        state: 'ready',
        tools: [{ name: 'search', description: 'Search code', inputSchema: {} }],
      }),
    ]
    vi.mocked(window.pine.chatTools.mcpRefresh).mockResolvedValue(live)
    useChatToolsStore.setState({ mcp: live })
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await user.click(screen.getByRole('button', { name: /Tools/ }))
    await user.click(await screen.findByRole('switch', { name: 'Offer search to the chat' }))
    await waitFor(() => expect(servers()[0].disabledTools).toEqual(['search']))
  })

  it('edits a server keeping its saved secret, and never shows the value', async () => {
    seed([github])
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await user.click(screen.getByRole('button', { name: 'Edit github' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit github' })
    expect(within(dialog).getByLabelText('Name')).toBeDisabled()
    const secret = within(dialog).getByLabelText('Secret value of GITHUB_TOKEN')
    expect(secret).toHaveValue('')
    expect(secret).toHaveAttribute('placeholder', 'Saved. Type to replace.')
    const args = within(dialog).getByLabelText('Arguments')
    await user.clear(args)
    await user.type(args, '-y other')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(servers()[0]).toMatchObject({
      command: ['npx', '-y', 'other'],
      secrets: ['GITHUB_TOKEN'],
    })
    expect(window.pine.chatTools.setMcpSecret).not.toHaveBeenCalled()
  })

  it('removes a server only after confirming, and deletes its secrets', async () => {
    seed([github])
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await user.click(screen.getByRole('button', { name: 'Remove github' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove github?' })
    expect(servers()).toHaveLength(1)
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(servers()).toEqual([]))
    expect(window.pine.chatTools.setMcpSecret).toHaveBeenCalledWith('github', 'GITHUB_TOKEN', null)
  })

  it('adds a skill folder from the folder picker, counts its skills and removes it', async () => {
    vi.mocked(window.pine.sync.pickFolder).mockResolvedValue('/home/u/skills/')
    vi.mocked(window.pine.chatTools.skills).mockResolvedValue([
      { name: 'deploy', description: '', path: '/home/u/skills/deploy/SKILL.md' },
      { name: 'other', description: '', path: '/elsewhere/other/SKILL.md' },
    ])
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.skillFolders).toEqual(['/home/u/skills']),
    )
    const list = await screen.findByRole('list', { name: 'Skill folders' })
    await waitFor(() => expect(list).toHaveTextContent('Found: deploy'))
    expect(list).not.toHaveTextContent('other')
    await user.click(screen.getByRole('button', { name: 'Remove /home/u/skills' }))
    await waitFor(() => expect(useSettingsStore.getState().assistant.skillFolders).toEqual([]))
  })

  it('refuses a picked folder that is not an absolute path', async () => {
    vi.mocked(window.pine.sync.pickFolder).mockResolvedValue('relative/skills')
    const user = userEvent.setup()
    render(<ChatToolsSettings />)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Add folder' }))
    })
    expect(await screen.findByText('Choose a folder with an absolute path.')).toBeInTheDocument()
    expect(useSettingsStore.getState().assistant.skillFolders).toEqual([])
  })
})
