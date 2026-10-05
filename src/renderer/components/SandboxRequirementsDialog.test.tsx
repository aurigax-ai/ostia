import '@testing-library/jest-dom/vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSandboxStore } from '../stores/sandboxStore'
import { SandboxRequirementsDialog } from './SandboxRequirementsDialog'

let init: ReturnType<typeof useSandboxStore.getState>

beforeAll(() => {
  init = useSandboxStore.getState()
})

afterEach(() => {
  useSandboxStore.setState(init, true)
})

const report = (canInstall: boolean) => ({
  missing: [{ program: 'bwrap', package: 'bubblewrap' }],
  hint: { command: 'sudo pacman -S --needed bubblewrap', packages: ['bubblewrap'] },
  canInstall,
})

describe('SandboxRequirementsDialog', () => {
  it('SBX-C95 keeps the sandbox off and names the missing package with an Install button', async () => {
    vi.mocked(window.ostia.sandbox.setEnabled).mockResolvedValue({
      ok: false,
      reason: 'missing-programs',
    })
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(report(true))
    render(<SandboxRequirementsDialog />)
    await act(() => useSandboxStore.getState().setEnabled('ws', true))
    expect(useSandboxStore.getState().enabled.ws).not.toBe(true)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('bubblewrap')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(window.ostia.system.installRequirements).toHaveBeenCalledWith('sandbox', 'ws')
  })

  it('SBX-C98 offers the command to copy when the system extension is not enabled', async () => {
    vi.mocked(window.ostia.sandbox.setEnabled).mockResolvedValue({
      ok: false,
      reason: 'missing-programs',
    })
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(report(false))
    render(<SandboxRequirementsDialog />)
    await act(() => useSandboxStore.getState().setEnabled('ws', true))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('sudo pacman -S --needed bubblewrap')
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
    expect(window.ostia.system.installRequirements).not.toHaveBeenCalled()
  })
})
