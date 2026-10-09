import '@testing-library/jest-dom/vitest'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { RequirementsReport } from '@shared/app/systemRequirements'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RequirementsNote } from './RequirementsNote'

const BODY = 'tmux 3.2 or newer is needed to keep shells.'
const COMMAND = 'sudo pacman -S --needed tmux'

function report(
  missing: RequirementsReport['missing'],
  canInstall: boolean,
  command: string | null = COMMAND,
): RequirementsReport {
  return { missing, hint: { command, packages: missing.map((m) => m.package) }, canInstall }
}

const met = report([], false)

describe('RequirementsNote', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    vi.mocked(window.ostia.system.requirements).mockReset().mockResolvedValue(null)
    vi.mocked(window.ostia.system.installRequirements).mockReset().mockResolvedValue({ ok: true })
  })

  it('says the program is not installed as an info note', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(
      report([{ program: 'tmux', package: 'tmux' }], true),
    )
    useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    expect(await screen.findByText('tmux is not installed.')).toBeInTheDocument()
    expect(screen.getByText(BODY)).toBeInTheDocument()
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the version found when the installed program is too old', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(
      report([{ program: 'tmux', package: 'tmux', needs: '3.2', found: '3.1c' }], true),
    )
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    expect(await screen.findByText('Found tmux 3.1c.')).toBeInTheDocument()
    expect(screen.queryByText('tmux is not installed.')).toBeNull()
  })

  it('says the installed program is too old when it would not name its version', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(
      report([{ program: 'tmux', package: 'tmux', needs: '3.2' }], true),
    )
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    expect(await screen.findByText('The installed tmux is too old.')).toBeInTheDocument()
  })

  it('offers one compact Install button that waits for the install', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(
      report([{ program: 'tmux', package: 'tmux' }], true),
    )
    let finish: () => void = () => {}
    vi.mocked(window.ostia.system.installRequirements).mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ ok: true })
      }),
    )
    useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    const user = userEvent.setup()
    const install = await screen.findByRole('button', { name: 'Install tmux' })
    expect(screen.queryByText(COMMAND)).toBeNull()
    await user.click(install)
    expect(window.ostia.system.installRequirements).toHaveBeenCalledWith('keep-shells', 'w1')
    expect(
      screen.getByText('Waiting for the install to finish in its terminal.'),
    ).toBeInTheDocument()
    expect(install).toBeDisabled()
    await act(async () => finish())
  })

  it('says it cannot install here and shows the command to copy', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(
      report([{ program: 'tmux', package: 'tmux' }], false),
    )
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    expect(await screen.findByText(COMMAND)).toBeInTheDocument()
    expect(
      screen.getByText(/can’t install it on this system\. Run this command/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install tmux' })).toBeNull()
  })

  it('names the packages when there is no command for this system', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(
      report([{ program: 'tmux', package: 'tmux' }], false, null),
    )
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    expect(
      await screen.findByText(/can’t install it on this system\. Install tmux with your/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
  })

  it('clears once a re-check after the install terminal ends finds the program', async () => {
    vi.mocked(window.ostia.system.requirements)
      .mockResolvedValueOnce(report([{ program: 'tmux', package: 'tmux' }], true))
      .mockResolvedValue(met)
    useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Install tmux' }))
    await vi.waitFor(() => expect(screen.queryByRole('note')).toBeNull())
    expect(window.ostia.system.requirements).toHaveBeenCalledTimes(2)
  })

  it('clears once a re-check on window focus finds the program', async () => {
    vi.mocked(window.ostia.system.requirements)
      .mockResolvedValueOnce(report([{ program: 'tmux', package: 'tmux' }], false))
      .mockResolvedValue(met)
    render(<RequirementsNote feature="keep-shells" body={BODY} />)
    expect(await screen.findByText('tmux is not installed.')).toBeInTheDocument()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() => expect(screen.queryByRole('note')).toBeNull())
  })
})
