import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import '@testing-library/jest-dom/vitest'
import { DEFAULT_CONTROLS, type SandboxFixedPolicy, type WorkspaceSandbox } from '@shared/sandbox'
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
    await userEvent.click(
      await screen.findByRole('tab', { name: `${PRODUCT_DISPLAY_NAME} access` }),
    )
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

const FIXED: SandboxFixedPolicy = {
  readable: ['/home/u/proj', '/tmp/pine-sandbox/ws'],
  writable: ['/home/u/proj', '/home/u/.claude'],
  hidden: ['/home/u', '/home/u/.config/pine'],
  readOnly: ['/home/u/.claude/settings.json', '/home/u/proj/.git/hooks'],
  hiddenSockets: ['/run/docker.sock', '/tmp/ssh-abc'],
  socketBlocking: true,
}

const GLOBALS = { allowRead: [], allowedDomains: [], controls: DEFAULT_CONTROLS }

describe('sandbox filesystem settings', () => {
  it('adds a global writable folder after main accepts it, and reloads the restart stamps', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    render(<SandboxSection />)
    const writable = screen.getByRole('group', { name: 'Writable folders' })
    await userEvent.type(within(writable).getByRole('textbox'), '~/builds')
    await userEvent.click(within(writable).getByRole('button', { name: 'Add' }))
    expect(window.pine.sandbox.checkPaths).toHaveBeenCalledWith('allowWrite', ['~/builds'])
    await waitFor(() =>
      expect(useSettingsStore.getState().sandbox?.allowWrite).toEqual(['~/builds']),
    )
    await waitFor(() => expect(window.pine.sandbox.globalsChanged).toHaveBeenCalled())
  })

  it('shows why main refused a global path and stores nothing', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.checkPaths).mockResolvedValue([
      { value: '/run/user/1000', reason: 'protected' },
    ])
    render(<SandboxSection />)
    const hidden = screen.getByRole('group', { name: 'Readable folders' })
    await userEvent.type(within(hidden).getByRole('textbox'), '/run/user/1000')
    await userEvent.click(within(hidden).getByRole('button', { name: 'Add' }))
    expect(await within(hidden).findByRole('alert')).toHaveTextContent(
      `${PRODUCT_DISPLAY_NAME} keeps that path closed`,
    )
    expect(useSettingsStore.getState().sandbox?.allowRead).toEqual([])
  })

  it('shows what Pine always allows and hides next to the global and workspace entries', async () => {
    useSettingsStore.setState({ sandbox: { ...GLOBALS, allowWrite: ['~/shared-out'] } })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue({ ...WORKSPACE, allowWrite: ['~/builds'] })
    vi.mocked(window.pine.sandbox.fixedPolicy).mockResolvedValue(FIXED)
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Files' }))
    const writable = screen.getByRole('group', { name: 'Writable folders' })
    expect(window.pine.sandbox.fixedPolicy).toHaveBeenCalledWith('ws')
    const always = (await within(writable).findByText('/home/u/proj')).closest('li')
    expect(always).toHaveTextContent('Always')
    expect(within(always as HTMLElement).queryByRole('button')).toBeNull()
    expect(within(writable).getByText('~/shared-out').closest('li')).toHaveTextContent('Global')
    expect(within(writable).getByRole('button', { name: 'Remove ~/builds' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Hidden paths' })).toHaveTextContent(
      '/home/u/.config/pine',
    )
    expect(screen.getByRole('group', { name: 'Read-only paths' })).toHaveTextContent(
      '/home/u/proj/.git/hooks',
    )
    expect(screen.getByRole('group', { name: 'Readable folders' })).toHaveTextContent(
      '/tmp/pine-sandbox/ws',
    )
  })

  it('sends a workspace hidden path to main and shows the stored list it answers with', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    vi.mocked(window.pine.sandbox.setPaths).mockResolvedValue({
      ok: true,
      settings: { ...WORKSPACE, denyRead: ['~/notes/private'] },
    })
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Files' }))
    const hidden = screen.getByRole('group', { name: 'Hidden paths' })
    await userEvent.type(within(hidden).getByRole('textbox'), '~/notes/private/')
    await userEvent.click(within(hidden).getByRole('button', { name: 'Add' }))
    expect(window.pine.sandbox.setPaths).toHaveBeenCalledWith('ws', 'denyRead', [
      '~/notes/private/',
    ])
    expect(
      await within(hidden).findByRole('button', { name: 'Remove ~/notes/private' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(window.pine.sandbox.stamp).toHaveBeenCalledWith('ws'))
  })

  it('lets git change its config for one workspace and resets back to the global default', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    vi.mocked(window.pine.sandbox.setSwitches)
      .mockResolvedValueOnce({ ...WORKSPACE, switches: { gitConfig: true } })
      .mockResolvedValueOnce(WORKSPACE)
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Files' }))
    const row = screen.getByRole('group', { name: 'Let git change its config' })
    expect(within(row).getByRole('switch')).not.toBeChecked()
    expect(row).toHaveTextContent('Inherited')
    await userEvent.click(within(row).getByRole('switch'))
    expect(window.pine.sandbox.setSwitches).toHaveBeenCalledWith('ws', { gitConfig: true })
    await waitFor(() => expect(within(row).getByRole('switch')).toBeChecked())
    expect(row).toHaveTextContent('Overridden')
    await userEvent.click(within(row).getByRole('button', { name: 'Reset' }))
    expect(window.pine.sandbox.setSwitches).toHaveBeenLastCalledWith('ws', {})
    await waitFor(() => expect(within(row).getByRole('switch')).not.toBeChecked())
  })
})

describe('sandbox Unix socket settings', () => {
  it('turns Unix sockets off globally and says what stops working on Linux', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.fixedPolicy).mockResolvedValue(FIXED)
    render(<SandboxSection />)
    const row = screen.getByRole('group', { name: 'Allow Unix sockets' })
    expect(row).toHaveTextContent('the pine command')
    expect(row).toHaveTextContent('Linux can only allow or block all of them')
    expect(within(row).getByRole('switch')).toBeChecked()
    await userEvent.click(within(row).getByRole('switch'))
    await waitFor(() =>
      expect(useSettingsStore.getState().sandbox?.switches).toEqual({
        unixSockets: false,
        gitConfig: false,
        strictDomains: false,
      }),
    )
    expect(screen.queryByRole('group', { name: 'Allowed sockets' })).toBeNull()
  })

  it('lists the sockets Pine hides, read-only', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.fixedPolicy).mockResolvedValue(FIXED)
    render(<SandboxSection />)
    const sockets = screen.getByRole('group', { name: 'Hidden sockets' })
    expect(await within(sockets).findByText('/run/docker.sock')).toBeInTheDocument()
    expect(within(sockets).getByText('/tmp/ssh-abc')).toBeInTheDocument()
    expect(within(sockets).queryByRole('button')).toBeNull()
    expect(within(sockets).queryByRole('textbox')).toBeNull()
  })

  it('says so when no container or agent socket is reachable', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.fixedPolicy).mockResolvedValue({ ...FIXED, hiddenSockets: [] })
    render(<SandboxSection />)
    expect(
      await screen.findByText('No container or agent socket is reachable on this computer.'),
    ).toBeInTheDocument()
  })

  it('disables the switch where the runtime cannot block sockets, instead of pretending', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.fixedPolicy).mockResolvedValue({
      ...FIXED,
      socketBlocking: false,
    })
    render(<SandboxSection />)
    const row = screen.getByRole('group', { name: 'Allow Unix sockets' })
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-disabled', 'true'),
    )
    expect(row).toHaveTextContent('This computer cannot block Unix sockets')
  })

  it('overrides Unix sockets for one workspace', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    vi.mocked(window.pine.sandbox.setSwitches).mockResolvedValue({
      ...WORKSPACE,
      switches: { unixSockets: false },
    })
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Network' }))
    const row = screen.getByRole('group', { name: 'Allow Unix sockets' })
    await userEvent.click(within(row).getByRole('switch'))
    expect(window.pine.sandbox.setSwitches).toHaveBeenCalledWith('ws', { unixSockets: false })
    await waitFor(() => expect(within(row).getByRole('switch')).not.toBeChecked())
    expect(row).toHaveTextContent('Overridden')
  })
})

describe('sandbox domain settings', () => {
  it('adds a blocked domain for a workspace and shows the global ones as inherited', async () => {
    useSettingsStore.setState({
      sandbox: { ...GLOBALS, deniedDomains: ['telemetry.example.com'] },
    })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    vi.mocked(window.pine.sandbox.setDeniedDomains).mockResolvedValue({
      ok: true,
      settings: { ...WORKSPACE, deniedDomains: ['ads.example.com'] },
    })
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Network' }))
    const blocked = screen.getByRole('group', { name: 'Blocked domains' })
    expect(within(blocked).getByText('telemetry.example.com').closest('li')).toHaveTextContent(
      'Global',
    )
    await userEvent.type(within(blocked).getByRole('textbox'), 'ads.example.com')
    await userEvent.click(within(blocked).getByRole('button', { name: 'Add' }))
    expect(window.pine.sandbox.setDeniedDomains).toHaveBeenCalledWith('ws', ['ads.example.com'])
    expect(
      await within(blocked).findByRole('button', { name: 'Remove ads.example.com' }),
    ).toBeInTheDocument()
  })

  it('refuses a bare * as a global blocked domain and stores a valid one', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    render(<SandboxSection />)
    const blocked = screen.getByRole('group', { name: 'Blocked domains' })
    await userEvent.type(within(blocked).getByRole('textbox'), '*')
    await userEvent.click(within(blocked).getByRole('button', { name: 'Add' }))
    expect(await within(blocked).findByRole('alert')).toHaveTextContent('A bare *')
    await userEvent.clear(within(blocked).getByRole('textbox'))
    await userEvent.type(within(blocked).getByRole('textbox'), 'ads.example.com')
    await userEvent.click(within(blocked).getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(useSettingsStore.getState().sandbox?.deniedDomains).toEqual(['ads.example.com']),
    )
  })

  it('turns on never asking about other domains globally', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    render(<SandboxSection />)
    const row = screen.getByRole('group', { name: 'Never ask about other domains' })
    await userEvent.click(within(row).getByRole('switch'))
    await waitFor(() =>
      expect(useSettingsStore.getState().sandbox?.switches?.strictDomains).toBe(true),
    )
  })
})

describe('workspace sandbox page layout', () => {
  it('puts every tab under the same group heading and row blocks as the rest of Settings', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Workspace: proj' })).toBeVisible()
    expect(screen.getByText(/It also inherits the defaults/)).toBeInTheDocument()
    const groups: [string, string][] = [
      ['General', 'Sandbox'],
      ['Files', 'Reading'],
      ['Files', 'Writing'],
      ['Network', 'Domains'],
      ['Network', 'Unix sockets'],
      ['Ports', 'Ports'],
      ['Secrets', 'Secrets'],
      ['Packages', 'Packages'],
      [`${PRODUCT_DISPLAY_NAME} access`, `${PRODUCT_DISPLAY_NAME} access`],
      ['Blocked', 'Blocked'],
    ]
    for (const [tab, heading] of groups) {
      await userEvent.click(screen.getByRole('tab', { name: tab }))
      const panel = screen.getByRole('tabpanel', { name: tab })
      expect(within(panel).getByRole('heading', { level: 3, name: heading })).toBeInTheDocument()
    }
  })
})

const FOUND = [
  { id: 'bun' as const, paths: ['~/.bun'] },
  { id: 'uv' as const, paths: ['~/.local/share/uv/tools', '~/.local/share/uv/python'] },
]

describe('sandbox tool-folder presets', () => {
  it('shows no preset block on a machine where main found no tool folder', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    render(<SandboxSection />)
    await waitFor(() => expect(window.pine.sandbox.presets).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: 'Tool folders' })).toBeNull()
  })

  it('adds a found preset’s folders to the global readable list in one click, named in the list', async () => {
    useSettingsStore.setState({ sandbox: { ...GLOBALS, allowRead: ['~/notes'] } })
    vi.mocked(window.pine.sandbox.presets).mockResolvedValue(FOUND)
    render(<SandboxSection />)
    const presets = await screen.findByRole('group', { name: 'Tool folders' })
    expect(within(presets).queryByRole('group', { name: 'Deno' })).toBeNull()
    const uv = within(presets).getByRole('group', { name: 'uv and pipx' })
    expect(uv).toHaveTextContent('~/.local/share/uv/tools, ~/.local/share/uv/python')
    expect(within(uv).getByRole('switch')).not.toBeChecked()
    await userEvent.click(within(uv).getByRole('switch'))
    expect(window.pine.sandbox.checkPaths).toHaveBeenCalledWith('allowRead', FOUND[1].paths)
    await waitFor(() =>
      expect(useSettingsStore.getState().sandbox?.allowRead).toEqual([
        '~/notes',
        ...FOUND[1].paths,
      ]),
    )
    await waitFor(() => expect(within(uv).getByRole('switch')).toBeChecked())
    const readable = screen.getByRole('group', { name: 'Readable folders' })
    const row = within(readable).getByText('~/.local/share/uv/tools').closest('li')
    expect(row).toHaveTextContent('uv and pipx')
    expect(within(readable).getByText('~/notes').closest('li')).not.toHaveTextContent('uv and pipx')
  })

  it('switches a preset off by removing its folders, and shows it off once one is removed by hand', async () => {
    useSettingsStore.setState({
      sandbox: { ...GLOBALS, allowRead: ['~/notes', '~/.bun', ...FOUND[1].paths] },
    })
    vi.mocked(window.pine.sandbox.presets).mockResolvedValue(FOUND)
    render(<SandboxSection />)
    const presets = await screen.findByRole('group', { name: 'Tool folders' })
    const bun = within(presets).getByRole('group', { name: 'Bun' })
    await userEvent.click(within(bun).getByRole('switch'))
    await waitFor(() =>
      expect(useSettingsStore.getState().sandbox?.allowRead).toEqual([
        '~/notes',
        ...FOUND[1].paths,
      ]),
    )
    const uv = within(presets).getByRole('group', { name: 'uv and pipx' })
    expect(within(uv).getByRole('switch')).toBeChecked()
    const readable = screen.getByRole('group', { name: 'Readable folders' })
    await userEvent.click(
      within(readable).getByRole('button', { name: 'Remove ~/.local/share/uv/python' }),
    )
    await waitFor(() => expect(within(uv).getByRole('switch')).not.toBeChecked())
  })

  it('shows why main refused a preset and stores nothing', async () => {
    useSettingsStore.setState({ sandbox: GLOBALS })
    vi.mocked(window.pine.sandbox.presets).mockResolvedValue(FOUND)
    vi.mocked(window.pine.sandbox.checkPaths).mockResolvedValue([
      { value: '~/.bun', reason: 'missing' },
    ])
    render(<SandboxSection />)
    const presets = await screen.findByRole('group', { name: 'Tool folders' })
    await userEvent.click(
      within(within(presets).getByRole('group', { name: 'Bun' })).getByRole('switch'),
    )
    expect(await within(presets).findByRole('alert')).toBeInTheDocument()
    expect(useSettingsStore.getState().sandbox?.allowRead).toEqual([])
  })

  it('shows a preset the defaults already open as on and locked in a workspace, and adds another for it alone', async () => {
    useSettingsStore.setState({ sandbox: { ...GLOBALS, allowRead: ['~/.bun'] } })
    vi.mocked(window.pine.sandbox.presets).mockResolvedValue(FOUND)
    vi.mocked(window.pine.sandbox.get).mockResolvedValue(WORKSPACE)
    vi.mocked(window.pine.sandbox.setPaths).mockResolvedValue({
      ok: true,
      settings: { ...WORKSPACE, allowRead: FOUND[1].paths },
    })
    render(<WorkspaceSandboxPage workspaceId="ws" workspaceName="proj" />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Files' }))
    const presets = await screen.findByRole('group', { name: 'Tool folders' })
    const bun = within(presets).getByRole('group', { name: 'Bun' })
    expect(within(bun).getByRole('switch')).toBeChecked()
    expect(within(bun).getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
    expect(bun).toHaveTextContent('Global')
    const uv = within(presets).getByRole('group', { name: 'uv and pipx' })
    await userEvent.click(within(uv).getByRole('switch'))
    expect(window.pine.sandbox.setPaths).toHaveBeenCalledWith('ws', 'allowRead', FOUND[1].paths)
    await waitFor(() => expect(within(uv).getByRole('switch')).toBeChecked())
    expect(uv).not.toHaveTextContent('Global')
  })
})
