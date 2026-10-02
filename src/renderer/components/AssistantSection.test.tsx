import '@testing-library/jest-dom/vitest'
import type { AssistCatalog, AssistExtensionState, AssistProviderConfig } from '@shared/assist'
import type { ExtensionInfo } from '@shared/extensions'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { resetChatTools } from '../stores/chatToolsStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { AssistantSection } from './AssistantSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const base = {
  version: '1.0.0',
  description: '',
  enabled: true,
  status: 'running',
  requested: ['assist'],
  granted: ['assist'],
  unapproved: [],
  commands: [],
  panel: null,
  paneChips: [],
  workspaceChips: [],
  settingValues: {},
  iconThemes: [],
  secrets: [],
  secretsSet: [],
  settingsPage: null,
  category: 'other',
  languages: [],
  languageServers: [],
  agentSkills: [],
  agentHooks: [],
} satisfies Partial<ExtensionInfo>

const assistant: ExtensionInfo = {
  ...base,
  id: 'assistant',
  name: 'Assistant',
  builtin: true,
  settings: [
    { key: 'chat', type: 'boolean', default: true, description: 'Chat switch.' },
    { key: 'typos', type: 'boolean', default: true, description: 'Typo switch.' },
    {
      key: 'requestsPerMinute',
      type: 'number',
      title: 'Request limit',
      default: 30,
      description: 'Most requests per minute.',
    },
  ],
  assist: ['input', 'chat'],
}

const runtime: ExtensionInfo = {
  ...base,
  id: 'model-runtime',
  name: 'Model runtime',
  builtin: false,
  settings: [
    { key: 'baseUrl', type: 'string', title: 'Address', default: '', description: 'Socket.' },
    { key: 'typos', type: 'boolean', default: true, description: 'Typo switch.' },
  ],
  assist: ['input', 'chat'],
}

const KINDS = [
  { id: 'ollama', title: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: 'optional' as const },
  { id: 'openai', title: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: 'required' as const },
]

const OLLAMA: AssistProviderConfig = {
  id: 'ollama',
  extId: 'assistant',
  kind: 'ollama',
  name: 'Ollama',
  baseUrl: '',
  enabled: true,
  models: ['qwen'],
}

const OPENAI: AssistProviderConfig = {
  id: 'openai',
  extId: 'assistant',
  kind: 'openai',
  name: 'OpenAI',
  baseUrl: '',
  enabled: true,
  models: ['gpt-big'],
}

const QWEN = { extId: 'assistant', provider: 'ollama', model: 'qwen' }
const GEMMA = { extId: 'model-runtime', provider: 'model-runtime', model: 'gemma' }

const assistantState: AssistExtensionState = {
  extId: 'assistant',
  name: 'Assistant',
  setup: null,
  features: [
    { id: 'chat', setting: 'chat', on: true, ready: true },
    { id: 'typos', setting: 'typos', on: true, ready: false },
  ],
  models: true,
  providers: [
    {
      id: 'ollama',
      kind: 'ollama',
      name: 'Ollama',
      setup: null,
      lifecycle: false,
      models: [{ id: 'qwen' }],
    },
    {
      id: 'openai',
      kind: 'openai',
      name: 'OpenAI',
      setup: 'no-key',
      lifecycle: false,
      models: [{ id: 'gpt-big' }],
    },
  ],
  kinds: KINDS,
  keysSet: [],
}

const runtimeState: AssistExtensionState = {
  extId: 'model-runtime',
  name: 'Model runtime',
  setup: null,
  features: [{ id: 'typos', setting: 'typos', on: false, ready: false }],
  models: true,
  providers: [
    {
      id: 'model-runtime',
      kind: 'model-runtime',
      name: 'Model runtime',
      setup: null,
      lifecycle: true,
      models: [{ id: 'gemma' }],
    },
  ],
  kinds: [],
  keysSet: [],
}

const catalog: AssistCatalog = {
  models: [
    { ref: QWEN, group: 'Ollama', label: 'qwen', points: ['input', 'chat'] },
    { ref: GEMMA, group: 'Model runtime', label: 'gemma', points: ['input', 'chat'] },
  ],
  chat: QWEN,
  fast: GEMMA,
}

describe('AssistantSection', () => {
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let assistInit: ReturnType<typeof useAssistStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    extInit = useExtensionsStore.getState()
    assistInit = useAssistStore.getState()
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useExtensionsStore.setState(extInit, true)
    useAssistStore.setState(assistInit, true)
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    resetChatTools()
    vi.mocked(window.pine.assist.models)
      .mockReset()
      .mockResolvedValue({ ok: false, error: 'unavailable' })
    vi.mocked(window.pine.assist.setModelLoaded).mockReset().mockResolvedValue({ ok: true })
    vi.restoreAllMocks()
  })

  function seed(providers: AssistProviderConfig[] = [OLLAMA, OPENAI]): void {
    useExtensionsStore.setState({ list: [assistant, runtime] })
    useAssistStore.setState({ overview: [assistantState, runtimeState], catalog })
    useSettingsStore.setState((s) => ({ assistant: { ...s.assistant, providers } }))
  }

  const provider = (name: string): HTMLElement =>
    within(screen.getByRole('list', { name: 'Providers' })).getByRole('listitem', { name })

  it('shows a short empty state that leads to Extensions while the extension is off', async () => {
    useExtensionsStore.setState({ list: [{ ...assistant, enabled: false }] })
    render(<AssistantSection />)
    expect(screen.getByText('The Assistant extension is off')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('Chat tools')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open Extensions' }))
    expect(useUIStore.getState().settingsSection).toBe('extensions')
    expect(useUIStore.getState().settingsExtension).toBe(assistant.id)
  })

  it('offers nothing but adding a provider until one is set up', () => {
    useExtensionsStore.setState({ list: [assistant] })
    useAssistStore.setState({
      overview: [{ ...assistantState, setup: 'no-provider', providers: [] }],
      catalog: { models: [], chat: null, fast: null },
    })
    render(<AssistantSection />)
    expect(screen.getByText('No providers yet')).toBeInTheDocument()
    expect(
      screen.getByText('Add a provider and a model first. Nothing is sent until then.'),
    ).toBeInTheDocument()
    expect(screen.getAllByText('No model yet')).toHaveLength(2)
    expect(screen.queryByRole('switch', { name: 'Ask chat' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeInTheDocument()
  })

  it('lists two providers with their own state, key and models, plus the one an extension brings', () => {
    seed()
    render(<AssistantSection />)
    expect(within(provider('Ollama')).getByRole('status')).toHaveTextContent('Ready')
    expect(within(provider('OpenAI')).getByRole('status')).toHaveTextContent('Needs an API key')
    expect(within(provider('OpenAI')).getByText('Required by this provider.')).toBeInTheDocument()
    expect(within(provider('OpenAI')).getByText('Not set')).toBeInTheDocument()
    expect(
      within(within(provider('OpenAI')).getByRole('list', { name: 'Models: OpenAI' })).getByText(
        'gpt-big',
      ),
    ).toBeInTheDocument()
    expect(
      within(provider('Ollama')).getByRole('textbox', { name: 'Base URL: Ollama' }),
    ).toHaveAttribute('placeholder', 'http://127.0.0.1:11434/v1')
    const fixed = provider('Model runtime')
    expect(fixed).toHaveTextContent('From the Model runtime extension')
    expect(fixed).toHaveTextContent('gemma')
    expect(within(fixed).queryByRole('switch')).toBeNull()
  })

  it('names the model each feature uses and flips the switch of the extension that serves it', async () => {
    const setSetting = vi.spyOn(useExtensionsStore.getState(), 'setSetting').mockResolvedValue(null)
    seed()
    render(<AssistantSection />)
    expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveTextContent('Ollama · qwen')
    expect(screen.getByRole('combobox', { name: 'Fast model' })).toHaveTextContent(
      'Model runtime · gemma',
    )
    const chat = document.querySelector('[data-feature="chat"]') as HTMLElement
    const typos = document.querySelector('[data-feature="typos"]') as HTMLElement
    expect(chat).toHaveTextContent('Uses Ollama · qwen')
    expect(typos).toHaveTextContent('Uses Model runtime · gemma')
    expect(screen.getByRole('button', { name: 'Try Ask chat' })).toBeInTheDocument()
    await userEvent.click(within(typos).getByRole('switch', { name: 'Typo fix' }))
    expect(setSetting).toHaveBeenCalledWith('model-runtime', 'typos', true)
  })

  it('picks the chat model from every usable model, grouped by provider', async () => {
    seed()
    render(<AssistantSection />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Chat model' }))
    await userEvent.click(await screen.findByRole('option', { name: 'gemma' }))
    await waitFor(() => expect(useSettingsStore.getState().assistant.chatModel).toEqual(GEMMA))
    await waitFor(() => expect(window.pine.fs.write).toHaveBeenCalled())
    const written = vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1] ?? ''
    expect(JSON.parse(written).assistant.chatModel).toEqual(GEMMA)
  })

  it('says when the chosen chat model is no longer offered and lets the human pick another', async () => {
    seed()
    useSettingsStore.setState((s) => ({
      assistant: {
        ...s.assistant,
        chatModel: { extId: 'assistant', provider: 'openai', model: 'gpt-big' },
      },
    }))
    useAssistStore.setState({ catalog: { ...catalog, chat: null } })
    render(<AssistantSection />)
    const field = screen.getByRole('combobox', { name: 'Chat model' })
    expect(field).toHaveTextContent('Not available: gpt-big. Pick another.')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    await userEvent.click(field)
    await userEvent.click(await screen.findByRole('option', { name: 'qwen' }))
    await waitFor(() => expect(useSettingsStore.getState().assistant.chatModel).toEqual(QWEN))
  })

  it('turns a provider off, renames it and changes its address without touching the other', async () => {
    seed()
    render(<AssistantSection />)
    await userEvent.click(within(provider('OpenAI')).getByRole('switch', { name: 'Use OpenAI' }))
    const url = within(provider('Ollama')).getByRole('textbox', { name: 'Base URL: Ollama' })
    await userEvent.type(url, 'http://box:11434/v1{Enter}')
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.providers).toEqual([
        { ...OLLAMA, baseUrl: 'http://box:11434/v1' },
        { ...OPENAI, enabled: false },
      ]),
    )
  })

  it('saves and clears a provider key through main and never keeps it in settings', async () => {
    seed()
    render(<AssistantSection />)
    const row = provider('OpenAI')
    await userEvent.type(within(row).getByLabelText('API key: OpenAI'), 'sk-secret-9')
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(window.pine.assist.setProviderKey).toHaveBeenCalledWith('openai', 'sk-secret-9')
    await waitFor(() => expect(within(row).getByLabelText('API key: OpenAI')).toHaveValue(''))
    expect(JSON.stringify(useSettingsStore.getState().assistant)).not.toContain('sk-secret-9')
    cleanup()
    useAssistStore.setState({
      overview: [{ ...assistantState, keysSet: ['openai'] }, runtimeState],
    })
    render(<AssistantSection />)
    expect(within(provider('OpenAI')).getByText('Set')).toBeInTheDocument()
    await userEvent.click(within(provider('OpenAI')).getByRole('button', { name: 'Clear' }))
    expect(window.pine.assist.setProviderKey).toHaveBeenLastCalledWith('openai', null)
  })

  it('adds a model the provider lists or one typed by hand, and removes one', async () => {
    vi.mocked(window.pine.assist.models).mockResolvedValue({
      ok: true,
      lifecycle: false,
      models: [{ id: 'qwen' }, { id: 'llama-small' }],
    })
    seed()
    render(<AssistantSection />)
    const input = within(provider('Ollama')).getByRole('combobox', { name: 'Model id for Ollama' })
    await userEvent.click(input)
    expect(window.pine.assist.models).toHaveBeenCalledWith('assistant', 'ollama')
    await userEvent.click(await screen.findByRole('option', { name: 'llama-small' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.providers[0].models).toEqual([
        'qwen',
        'llama-small',
      ]),
    )
    expect(screen.queryByRole('option', { name: 'qwen' })).toBeNull()
    await userEvent.type(input, 'my/own-model')
    await userEvent.click(await screen.findByRole('option', { name: 'Add “my/own-model”' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.providers[0].models).toEqual([
        'qwen',
        'llama-small',
        'my/own-model',
      ]),
    )
    await userEvent.click(within(provider('Ollama')).getByRole('button', { name: 'Remove qwen' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.providers[0].models).toEqual([
        'llama-small',
        'my/own-model',
      ]),
    )
  })

  it('adds a provider of a kind an extension offers and removes one after a confirm', async () => {
    seed([OLLAMA])
    render(<AssistantSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'OpenAI' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.providers).toEqual([
        OLLAMA,
        { ...OPENAI, models: [] },
      ]),
    )
    await userEvent.click(within(provider('Ollama')).getByRole('button', { name: 'Remove Ollama' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove Ollama?')
    expect(useSettingsStore.getState().assistant.providers).toHaveLength(2)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().assistant.providers.map((p) => p.id)).toEqual(['openai']),
    )
  })

  it("keeps an extension's own settings without repeating the feature switches", () => {
    seed()
    render(<AssistantSection />)
    expect(screen.getByRole('spinbutton', { name: 'Request limit' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Address' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Chat' })).toBeNull()
    expect(screen.getByText('Chat tools')).toBeInTheDocument()
  })

  it('lists the models of a provider that can load them and loads one through main', async () => {
    vi.mocked(window.pine.assist.models).mockResolvedValue({
      ok: true,
      lifecycle: true,
      models: [
        { id: 'gemma', name: 'Gemma', loaded: true, idleSecs: 90 },
        { id: 'qwen', loaded: false },
      ],
    })
    seed()
    render(<AssistantSection />)
    const list = await screen.findByRole('list', { name: 'Models: Model runtime' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('In use')
    expect(rows[0]).toHaveTextContent('Gemma · Loaded · idle 2 min')
    expect(rows[1]).toHaveTextContent('Not loaded')
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Load' }))
    expect(window.pine.assist.setModelLoaded).toHaveBeenCalledWith(
      'model-runtime',
      'qwen',
      true,
      'model-runtime',
    )
    await waitFor(() => expect(window.pine.assist.models).toHaveBeenCalledTimes(2))
  })

  it('shows the error a provider gave for its model list', async () => {
    vi.mocked(window.pine.assist.models).mockResolvedValue({
      ok: true,
      lifecycle: false,
      models: [],
      error: 'connection refused',
    })
    seed()
    render(<AssistantSection />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not list models: connection refused',
    )
  })
})
