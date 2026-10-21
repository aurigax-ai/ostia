import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'

const { search, emptyPage } = vi.hoisted(() => {
  const holder = { useSearchLeaf: (_texts: readonly string[]): boolean => false }
  const page = (): null => {
    for (const text of ['b', 'bl', 'bli', 'blin']) holder.useSearchLeaf([text])
    return null
  }
  return { search: holder, emptyPage: page }
})

vi.mock('@/components/agents/AgentsSection', () => ({ AgentsSection: emptyPage }))
vi.mock('@/components/app/AboutSection', () => ({ AboutSection: emptyPage }))
vi.mock('@/components/assist/AssistantSection', () => ({ AssistantSection: emptyPage }))
vi.mock('@/components/extensions/ExtensionSettingsPage', () => ({
  ExtensionSettingsPage: emptyPage,
  ExtensionsPage: emptyPage,
}))
vi.mock('@/components/gateway/GatewaySection', () => ({ GatewaySection: emptyPage }))
vi.mock('@/components/keyboard/KeyboardSection', () => ({ KeyboardSection: emptyPage }))
vi.mock('@/components/panes/PanesSection', () => ({ PanesSection: emptyPage }))
vi.mock('@/components/sandbox/SandboxSection', () => ({ SandboxSection: emptyPage }))
vi.mock('@/components/sandbox/WorkspaceSandboxPage', () => ({ WorkspaceSandboxPage: emptyPage }))
vi.mock('@/components/scriptTokens/ScriptTokensSection', () => ({ ScriptTokensSection: emptyPage }))
vi.mock('@/components/sidebar/SidebarSection', () => ({ SidebarSection: emptyPage }))
vi.mock('@/components/views/ViewsSection', () => ({ ViewsSection: emptyPage }))
vi.mock('./ActionsSection', () => ({ ActionsSection: emptyPage }))
vi.mock('./AppearanceSection', () => ({ AppearanceSection: emptyPage }))
vi.mock('./BoardSettings', () => ({ GitSection: emptyPage, PortsSection: emptyPage }))
vi.mock('./BrowserEditorSettings', () => ({
  BrowserSettingsSection: emptyPage,
  EditorSettingsSection: emptyPage,
}))
vi.mock('./FilesSettingsSection', () => ({ FilesSection: emptyPage }))
vi.mock('./ManagerSection', () => ({ ManagerSection: emptyPage }))
vi.mock('./NotificationsSection', () => ({ NotificationsSection: emptyPage }))
vi.mock('./PasswordsSection', () => ({ PasswordsSection: emptyPage }))
vi.mock('./PrivacySection', () => ({ PrivacySection: emptyPage }))
vi.mock('./PromptSection', () => ({ PromptSection: emptyPage }))
vi.mock('./SyncSection', () => ({ SyncSection: emptyPage }))
vi.mock('./WorkspacesSection', () => ({ WorkspacesSection: emptyPage }))

const renders = new Map<string, number>()

vi.mock('@/components/settingsKit/SettingsSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/settingsKit/SettingsSearch')>()
  search.useSearchLeaf = actual.useSearchLeaf
  return {
    ...actual,
    useSearchRow: (texts: readonly (string | null | undefined)[]) => {
      const label = String(texts[0])
      renders.set(label, (renders.get(label) ?? 0) + 1)
      return actual.useSearchRow(texts)
    },
  }
})

import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const QUERY = 'blink'
const ROW = 'Copy on select'
const MOUNT_AND_MATCH_FLIPS = 3

describe('SettingsPanel search renders', () => {
  beforeAll(() => {
    Object.assign(window, { queryLocalFonts: async () => [] })
  })

  afterEach(() => {
    cleanup()
    renders.clear()
    useUIStore.setState({ settingsActive: false, settingsTabOpen: false })
  })

  it('re-renders a row that does not match the query only when its own match flips', async () => {
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
    render(<SettingsPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Search settings' }))

    await user.type(screen.getByRole('textbox', { name: 'Search settings' }), QUERY)

    expect(QUERY).toHaveLength(5)
    expect(screen.getByRole('textbox', { name: 'Search settings' })).toHaveValue(QUERY)
    expect(renders.get(ROW)).toBeLessThanOrEqual(MOUNT_AND_MATCH_FLIPS)
  })
})
