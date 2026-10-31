import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { AgentsSection } from './AgentsSection'

let init: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  init = useSettingsStore.getState()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(init, true)
})

describe('Settings › Agents, ask before the Agent acts', () => {
  it('lists the two acting tools, both off by default', () => {
    render(<AgentsSection />)
    expect(screen.getByRole('switch', { name: 'Start an agent' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Message an agent' })).not.toBeChecked()
  })

  it('puts one tool on and back off the always-ask list', async () => {
    render(<AgentsSection />)
    await userEvent.click(screen.getByRole('switch', { name: 'Message an agent' }))
    expect(useSettingsStore.getState().agent.alwaysAsk).toEqual(['ostia_bus_send'])
    expect(screen.getByRole('switch', { name: 'Message an agent' })).toBeChecked()
    await userEvent.click(screen.getByRole('switch', { name: 'Message an agent' }))
    expect(useSettingsStore.getState().agent.alwaysAsk).toEqual([])
  })
})
