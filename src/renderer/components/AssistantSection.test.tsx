import '@testing-library/jest-dom/vitest'
import type { AssistExtensionState } from '@shared/assist'
import type { ExtensionInfo } from '@shared/extensions'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { resetChatTools } from '../stores/chatToolsStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useUIStore } from '../stores/uiStore'
import { AssistantSection } from './AssistantSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const assistant: ExtensionInfo = {
  id: 'assistant',
  name: 'Assistant',
  version: '1.0.0',
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
  settings: [
    {
      key: 'provider',
      type: 'enum',
      values: ['none', 'model-runtime'],
      default: 'none',
      description: 'Where requests go.',
    },
    { key: 'fastModel', type: 'string', default: '', description: 'Fast model.' },
    { key: 'chat', type: 'boolean', default: true, description: 'Chat switch.' },
    { key: 'typos', type: 'boolean', default: true, description: 'Typo switch.' },
  ],
  settingValues: { provider: 'model-runtime', fastModel: 'gemma' },
  iconThemes: [],
  assist: ['input', 'chat'],
  secrets: [],
  secretsSet: [],
}

const overview: AssistExtensionState = {
  extId: 'assistant',
  name: 'Assistant',
  label: 'model-runtime · gemma',
  setup: null,
  features: [
    { id: 'chat', setting: 'chat', on: true, ready: true },
    { id: 'typos', setting: 'typos', on: true, ready: false },
  ],
  models: true,
}

describe('AssistantSection', () => {
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let assistInit: ReturnType<typeof useAssistStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    extInit = useExtensionsStore.getState()
    assistInit = useAssistStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useExtensionsStore.setState(extInit, true)
    useAssistStore.setState(assistInit, true)
    useUIStore.setState(uiInit, true)
    resetChatTools()
    vi.mocked(window.pine.assist.models)
      .mockReset()
      .mockResolvedValue({ ok: false, error: 'unavailable' })
    vi.mocked(window.pine.assist.setModelLoaded).mockReset().mockResolvedValue({ ok: true })
    vi.restoreAllMocks()
  })

  function seed(): void {
    useExtensionsStore.setState({ list: [assistant] })
    useAssistStore.setState({ overview: [overview] })
  }

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

  it('lists features with status and Try it, and flips a feature through its setting', async () => {
    const setSetting = vi.spyOn(useExtensionsStore.getState(), 'setSetting').mockResolvedValue(null)
    seed()
    render(<AssistantSection />)
    expect(screen.getByText('model-runtime · gemma')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try Ask chat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try Typo fix' })).toBeNull()
    expect(screen.getByText('Not ready')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Typo fix' }))
    expect(setSetting).toHaveBeenCalledWith('assistant', 'typos', false)
  })

  it('shows provider settings without repeating the feature switches', () => {
    seed()
    render(<AssistantSection />)
    expect(screen.getByRole('combobox', { name: 'Provider' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Fast model' })).toHaveValue('gemma')
    expect(screen.queryByRole('switch', { name: 'Chat' })).toBeNull()
    expect(screen.getByText('Chat tools')).toBeInTheDocument()
  })

  it('lists models with their state and loads one through main', async () => {
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
    const list = await screen.findByRole('list', { name: 'Models' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('In use')
    expect(rows[0]).toHaveTextContent('Gemma · Loaded · idle 2 min')
    expect(rows[1]).toHaveTextContent('Not loaded')
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Load' }))
    expect(window.pine.assist.setModelLoaded).toHaveBeenCalledWith('assistant', 'qwen', true)
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
