import '@testing-library/jest-dom/vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagerSection } from './ManagerSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const manager = () => useSettingsStore.getState().manager

describe('ManagerSection', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(null)
    vi.mocked(window.ostia.system.installRequirements).mockClear()
  })

  it('MGR-C34 lists the built-in presets and adds one typed as a command line', async () => {
    render(<ManagerSection />)
    const user = userEvent.setup()
    expect(screen.getByLabelText('Command for claude')).toHaveValue('claude')
    expect(screen.getAllByText('Built-in')).toHaveLength(2)

    await user.type(screen.getByLabelText('Name'), 'aider')
    await user.type(screen.getByLabelText('Command and arguments'), `aider --model 'gpt x'`)
    await user.click(screen.getByRole('button', { name: 'Add preset' }))

    expect(manager().agents).toEqual({ aider: ['aider', '--model', 'gpt x'] })
    expect(screen.getByLabelText('Command for aider')).toHaveValue(`aider --model 'gpt x'`)
  })

  it('MGR-C34 refuses a bad name or an unclosed quote and saves nothing', async () => {
    render(<ManagerSection />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Name'), 'bad name')
    await user.type(screen.getByLabelText('Command and arguments'), 'x')
    await user.click(screen.getByRole('button', { name: 'Add preset' }))
    expect(screen.getByText(/Use letters, digits/)).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'ok')
    await user.clear(screen.getByLabelText('Command and arguments'))
    await user.type(screen.getByLabelText('Command and arguments'), `x "open`)
    await user.click(screen.getByRole('button', { name: 'Add preset' }))
    expect(screen.getByText(/Close every quote/)).toBeInTheDocument()
    expect(manager().agents).toEqual({})
  })

  it('MGR-C34 overriding a built-in preset replaces it, and removing the override restores it', async () => {
    render(<ManagerSection />)
    const user = userEvent.setup()
    const input = screen.getByLabelText('Command for claude')
    await user.clear(input)
    await user.type(input, 'claude --model opus{Enter}')
    expect(manager().agents).toEqual({ claude: ['claude', '--model', 'opus'] })
    expect(screen.getAllByText('Built-in')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Remove claude' }))
    expect(manager().agents).toEqual({})
    expect(screen.getByLabelText('Command for claude')).toHaveValue('claude')
  })

  it('MGR-C34 adds absolute skill folders only and removes them', async () => {
    render(<ManagerSection />)
    const user = userEvent.setup()
    const input = screen.getByLabelText('Absolute path of a skill folder')
    await user.type(input, 'relative/skill{Enter}')
    expect(screen.getByText('Enter an absolute path to a folder.')).toBeInTheDocument()
    expect(manager().skills).toEqual([])

    await user.clear(input)
    await user.type(input, '/home/u/skills/review/{Enter}')
    expect(manager().skills).toEqual(['/home/u/skills/review'])
    await user.click(screen.getByRole('button', { name: 'Remove /home/u/skills/review' }))
    expect(manager().skills).toEqual([])
  })

  it('MGR-C34 turns typing into panes on and sets a limit', async () => {
    render(<ManagerSection />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Allow typing into other panes' }))
    expect(manager().allowInput).toBe(true)

    const workers = screen.getByLabelText('Live workers')
    await user.clear(workers)
    await user.type(workers, '3{Enter}')
    expect(manager().limits.maxWorkers).toBe(3)
  })

  const missingSs = (canInstall: boolean) => ({
    missing: [{ program: 'ss', package: 'iproute2' }],
    hint: { command: 'sudo pacman -S --needed iproute2', packages: ['iproute2'] },
    canInstall,
  })

  it('MGR-C40 names the missing package and installs it through the approved flow', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(missingSs(true))
    useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
    render(<ManagerSection />)
    const user = userEvent.setup()
    expect(await screen.findByText(/iproute2 is needed/)).toBeInTheDocument()
    expect(window.ostia.system.requirements).toHaveBeenCalledWith('manager')
    await user.click(screen.getByRole('button', { name: 'Install iproute2' }))
    expect(window.ostia.system.installRequirements).toHaveBeenCalledWith('manager', 'w1')
  })

  it('MGR-C40 shows the command to copy when the install flow is unavailable', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(missingSs(false))
    render(<ManagerSection />)
    expect(await screen.findByText('sudo pacman -S --needed iproute2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install iproute2' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
  })

  it('MGR-C40 shows nothing when ss is installed', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue({
      missing: [],
      hint: { command: null, packages: [] },
      canInstall: false,
    })
    render(<ManagerSection />)
    await screen.findByText('Agents')
    expect(screen.queryByText(/needs/)).toBeNull()
  })
})
