import '@testing-library/jest-dom/vitest'
import { DEFAULT_CONTROLS, type WorkspaceSandbox } from '@shared/sandbox'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { SandboxSection } from './SandboxSection'
import { WorkspaceSandboxPage } from './WorkspaceSandboxPage'

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  useSettingsStore.setState(settingsInit, true)
})

const WORKSPACE: WorkspaceSandbox = {
  enabled: true,
  allowRead: [],
  domains: ['example.com'],
  controls: { allWorkspaces: true },
}

describe('sandbox settings', () => {
  it('SBX-C36 adds a global domain and tells main to apply it to running sandboxes', async () => {
    useSettingsStore.setState({
      sandbox: { allowRead: [], allowedDomains: ['api.github.com'], controls: DEFAULT_CONTROLS },
    })
    render(<SandboxSection />)
    const domains = screen.getByRole('group', { name: 'Allowed domains' })
    await userEvent.type(within(domains).getByRole('textbox'), 'example.org')
    await userEvent.click(within(domains).getByRole('button', { name: 'Add' }))
    expect(useSettingsStore.getState().sandbox?.allowedDomains).toEqual([
      'api.github.com',
      'example.org',
    ])
    await waitFor(() => expect(window.pine.sandbox.globalsChanged).toHaveBeenCalled())
    expect(window.pine.fs.write).toHaveBeenCalled()
  })

  it('SBX-C60 shows global domains as inherited next to the workspace own domains', async () => {
    useSettingsStore.setState({
      sandbox: { allowRead: [], allowedDomains: ['api.github.com'], controls: DEFAULT_CONTROLS },
    })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Network' }))
    const domains = screen.getByRole('group', { name: 'Allowed domains' })
    const inherited = within(domains).getByText('api.github.com').closest('li')
    expect(inherited).toHaveTextContent('Global')
    const own = within(domains).getByText('example.com').closest('li')
    expect(own).not.toHaveTextContent('Global')
    expect(
      within(own as HTMLElement).getByRole('button', { name: 'Remove example.com' }),
    ).toBeInTheDocument()
  })

  it('SBX-C61 keeps a workspace override when the global default changes, until Reset', async () => {
    useSettingsStore.setState({
      sandbox: { allowRead: [], allowedDomains: [], controls: DEFAULT_CONTROLS },
    })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    vi.mocked(window.pine.sandbox.setControls).mockResolvedValue({ ...WORKSPACE, controls: {} })
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Pine access' }))
    const row = screen.getByRole('group', { name: 'Act on other workspaces' })
    expect(within(row).getByRole('switch')).toBeChecked()
    expect(row).toHaveTextContent('Overridden')
    act(() => {
      useSettingsStore.setState({
        sandbox: {
          allowRead: [],
          allowedDomains: [],
          controls: { ...DEFAULT_CONTROLS, allWorkspaces: false },
        },
      })
    })
    expect(within(row).getByRole('switch')).toBeChecked()
    await userEvent.click(within(row).getByRole('button', { name: 'Reset' }))
    expect(window.pine.sandbox.setControls).toHaveBeenCalledWith('ws', {})
    await waitFor(() => expect(within(row).getByRole('switch')).not.toBeChecked())
    expect(row).toHaveTextContent('Inherited')
  })
})
