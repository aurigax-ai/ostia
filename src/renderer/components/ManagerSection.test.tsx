import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { ManagerSection } from './ManagerSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const manager = () => useSettingsStore.getState().manager

describe('ManagerSection', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
  })

  it('MGR-C34 lists the built-in presets and adds one typed as a command line', async () => {
    render(<ManagerSection />)
    const user = userEvent.setup()
    expect(screen.getByLabelText('Command for claude')).toHaveValue('claude')
    expect(screen.getAllByText('Built in')).toHaveLength(2)

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
    expect(screen.getAllByText('Built in')).toHaveLength(1)

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
})
