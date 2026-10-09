import '@testing-library/jest-dom/vitest'
import { startAssistToggleCommands } from '@/commands/assistToggles'
import { commands } from '@/commands/registry'
import { shortcutMap, startShortcutReporting } from '@/lib/assist/assistShortcuts'
import { openChatPane } from '@/lib/assist/chatPane'
import { useAssistStore } from '@/stores/assistStore'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useUIStore } from '@/stores/uiStore'
import type { AssistExtensionState } from '@shared/assist'
import type { ExtensionInfo } from '@shared/extensions'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AssistantMenu } from './AssistantMenu'

vi.mock('@/lib/assist/chatPane', () => ({ openChatPane: vi.fn() }))

const assistant: ExtensionInfo = {
  id: 'assistant',
  name: 'Assistant',
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
  assist: ['chat', 'terminal'],
  secrets: [],
  secretsSet: [],
  settingsPage: null,
  category: 'other',
  languages: [],
  languageServers: [],
  agentSkills: [],
  agentHooks: [],
  iconThemes: [],
  keymaps: [],
}

const ready: AssistExtensionState = {
  extId: 'assistant',
  name: 'Assistant',
  label: 'model-runtime · gemma',
  setup: null,
  models: false,
  providers: [],
  kinds: [],
  keysSet: [],
  features: [
    { id: 'chat', setting: 'chat', on: true, ready: true },
    { id: 'terminalCompletions', setting: 'terminalCompletions', on: true, ready: true },
  ],
}

describe('AssistantMenu', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let assistInit: ReturnType<typeof useAssistStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
    extInit = useExtensionsStore.getState()
    assistInit = useAssistStore.getState()
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState(uiInit, true)
    useExtensionsStore.setState(extInit, true)
    useAssistStore.setState(assistInit, true)
    vi.restoreAllMocks()
    vi.mocked(openChatPane).mockClear()
  })

  const CHAT_REF = { extId: 'assistant', provider: 'openai', model: 'gpt-big' }
  const FAST_REF = { extId: 'assistant', provider: 'ollama', model: 'qwen' }

  function seed(overview: AssistExtensionState[], configured = true): void {
    useExtensionsStore.setState({ list: [assistant] })
    useAssistStore.setState({
      overview,
      availability: {
        chat: { extId: 'assistant', name: 'Assistant', label: 'x', ref: CHAT_REF },
      },
      catalog: configured
        ? {
            models: [
              { ref: FAST_REF, group: 'Ollama', label: 'qwen', points: ['terminal', 'chat'] },
              { ref: CHAT_REF, group: 'OpenAI', label: 'gpt-big', points: ['terminal', 'chat'] },
            ],
            chat: CHAT_REF,
            fast: FAST_REF,
          }
        : { models: [], chat: null, fast: null },
    })
  }

  it('stays hidden while no enabled extension serves assist', () => {
    useExtensionsStore.setState({ list: [{ ...assistant, assist: [] }] })
    render(<AssistantMenu />)
    expect(screen.queryByRole('button', { name: /Assistant/ })).toBeNull()
  })

  it('turns a feature off by writing its own setting', async () => {
    const setSetting = vi.spyOn(useExtensionsStore.getState(), 'setSetting').mockResolvedValue(null)
    seed([ready])
    render(<AssistantMenu />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Assistant' }))
    const features = await screen.findByRole('list', { name: 'Features' })
    expect(within(features).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('OpenAI · gpt-big')).toBeInTheDocument()
    expect(screen.getByText('Ollama · qwen')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings|Models/i })).toBeNull()
    await user.click(screen.getByRole('switch', { name: 'Terminal completion' }))
    expect(setSetting).toHaveBeenCalledWith('assistant', 'terminalCompletions', false)
  })

  it('opens the chat from the main button without showing the feature list', async () => {
    seed([ready])
    render(<AssistantMenu />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Open chat/ }))
    expect(openChatPane).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('list', { name: 'Features' })).toBeNull()
  })

  it('shows how to set it up from the main button while chat is not ready', async () => {
    useExtensionsStore.setState({ list: [assistant] })
    useAssistStore.setState({ overview: [{ ...ready, setup: 'no-provider' }], availability: {} })
    render(<AssistantMenu />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Open chat/ }))
    expect(openChatPane).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Set up the assistant' })).toBeInTheDocument()
  })

  it('offers only the setup call to action while the provider is not set up', async () => {
    seed([{ ...ready, setup: 'no-provider' }], false)
    render(<AssistantMenu />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Assistant' }))
    expect(await screen.findByText('No provider is set up yet.')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Set up the assistant' }))
    expect(useUIStore.getState().settingsActive).toBe(true)
    expect(useUIStore.getState().settingsSection).toBe('assistant')
  })
})

describe('assist toggle commands', () => {
  let assistInit: ReturnType<typeof useAssistStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    assistInit = useAssistStore.getState()
    extInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    useAssistStore.setState(assistInit, true)
    useExtensionsStore.setState(extInit, true)
    vi.restoreAllMocks()
  })

  it('registers a toggle per reported feature and drops them when the report goes', async () => {
    const setSetting = vi.spyOn(useExtensionsStore.getState(), 'setSetting').mockResolvedValue(null)
    const stop = startAssistToggleCommands()
    useAssistStore.setState({ overview: [ready] })
    const id = 'assist.toggle.assistant.chat'
    expect(commands.list().find((c) => c.id === id)?.title).toBe('Toggle Ask chat')
    await commands.exec(id)
    expect(setSetting).toHaveBeenCalledWith('assistant', 'chat', false)
    useAssistStore.setState({ overview: [] })
    expect(commands.has(id)).toBe(false)
    stop()
  })
})

describe('shortcut reporting', () => {
  it('reports the default composer chord to main', () => {
    const report = vi.mocked(window.ostia.assist.reportShortcuts)
    report.mockClear()
    const stop = startShortcutReporting()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0]['assist.compose']).toBe(shortcutMap(false)['assist.compose'])
    expect(report.mock.calls[0][0]['assist.compose']).toMatch(/J/)
    stop()
  })
})
