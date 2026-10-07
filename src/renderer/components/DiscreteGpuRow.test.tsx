import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { DiscreteGpuRow } from './DiscreteGpuRow'

const READY = { missing: [], hint: { command: null, packages: [] }, canInstall: false }
const ARC = { name: 'Intel Corporation DG2 [Arc A370M]', inUse: false }

describe('DiscreteGpuRow', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(null)
    vi.mocked(window.ostia.system.discreteGpu).mockResolvedValue(null)
    vi.mocked(window.ostia.update.restart).mockClear()
  })

  it('refuses to turn on while switcheroo-control is missing', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue({
      missing: [{ program: 'switcherooctl', package: 'switcheroo-control' }],
      hint: {
        command: 'sudo pacman -S --needed switcheroo-control',
        packages: ['switcheroo-control'],
      },
      canInstall: false,
    })
    render(<DiscreteGpuRow />)
    expect(await screen.findByText('switcheroo-control is needed to pick the GPU.')).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Use the discrete GPU' })).toHaveAttribute(
      'data-disabled',
    )
  })

  it('refuses to turn on when switcheroo-control lists no discrete GPU', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(READY)
    render(<DiscreteGpuRow />)
    expect(await screen.findByText('switcheroo-control lists no discrete GPU.')).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Use the discrete GPU' })).toHaveAttribute(
      'data-disabled',
    )
  })

  it('turns on, says it applies on the next start and offers a restart', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue(READY)
    vi.mocked(window.ostia.system.discreteGpu).mockResolvedValue(ARC)
    render(<DiscreteGpuRow />)
    const user = userEvent.setup()
    expect(await screen.findByText(`Discrete GPU: ${ARC.name}`)).toBeVisible()
    expect(screen.queryByText('Applies on the next start.')).toBeNull()
    await user.click(screen.getByRole('switch', { name: 'Use the discrete GPU' }))
    expect(useSettingsStore.getState().behavior.discreteGpu).toBe(true)
    expect(screen.getByText('Applies on the next start.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Restart' }))
    expect(window.ostia.update.restart).toHaveBeenCalledOnce()
  })
})
