import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { TerminalLinksGroup } from './TerminalLinksGroup'

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(settingsInit, true)
})

describe('TerminalLinksGroup', () => {
  it('turns the question on by default and switches it off', async () => {
    render(<TerminalLinksGroup />)
    const toggle = screen.getByRole('switch', { name: 'Ask before opening apps from links' })
    expect(toggle).toBeChecked()
    await userEvent.setup().click(toggle)
    expect(useSettingsStore.getState().terminal.askBeforeOpeningApps).toBe(false)
  })

  it('lists the allowed schemes and removes one', async () => {
    useSettingsStore.getState().setTerminal({ allowedAppSchemes: ['obsidian', 'vscode'] })
    render(<TerminalLinksGroup />)
    expect(screen.getByText('obsidian:')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove obsidian:' }))
    expect(useSettingsStore.getState().terminal.allowedAppSchemes).toEqual(['vscode'])
  })

  it('says no app is allowed while the list is empty', () => {
    render(<TerminalLinksGroup />)
    expect(screen.getByText(/No app is allowed yet/)).toBeInTheDocument()
  })
})
