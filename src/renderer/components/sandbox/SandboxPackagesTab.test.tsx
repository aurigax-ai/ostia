import '@testing-library/jest-dom/vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  DEFAULT_CONTROLS,
  DEFAULT_PACKAGE_SETTINGS,
  type WorkspaceSandbox,
  resolvePackages,
} from '@shared/sandbox'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkspaceSandboxPage } from './WorkspaceSandboxPage'

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(settingsInit, true)
})

const GLOBALS = {
  allowRead: [],
  allowedDomains: [],
  controls: DEFAULT_CONTROLS,
  packages: { ...DEFAULT_PACKAGE_SETTINGS, cooldownDays: 2 },
}

describe('Packages tab', () => {
  it('SBX-C59 applies a workspace cooldown override only to that workspace and offers Reset', async () => {
    const overridden: WorkspaceSandbox = {
      enabled: true,
      allowRead: [],
      domains: [],
      controls: {},
      packages: { cooldownDays: 0 },
    }
    const plain: WorkspaceSandbox = { enabled: true, allowRead: [], domains: [], controls: {} }
    expect(resolvePackages(GLOBALS, overridden).cooldownDays).toBe(0)
    expect(resolvePackages(GLOBALS, plain).cooldownDays).toBe(2)

    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.ostia.sandbox.get).mockResolvedValue(overridden)
    vi.mocked(window.ostia.sandbox.setPackages).mockResolvedValue({ ...overridden, packages: {} })
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Packages' }))
    const row = screen.getByRole('group', { name: 'Cooldown (days)' })
    expect(within(row).getByRole('spinbutton')).toHaveValue(0)
    expect(row).toHaveTextContent('Overridden')
    await userEvent.click(within(row).getByRole('button', { name: 'Reset' }))
    expect(window.ostia.sandbox.setPackages).toHaveBeenCalledWith('ws', {})
    await waitFor(() => expect(within(row).getByRole('spinbutton')).toHaveValue(2))
    expect(row).toHaveTextContent('Inherited')
  })
})
