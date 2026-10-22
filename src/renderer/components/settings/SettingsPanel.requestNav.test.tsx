import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const current = (): string | undefined =>
  within(screen.getByRole('navigation'))
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'page')?.textContent ?? undefined

describe('SettingsPanel nav follows a request for a page', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
  })

  beforeEach(() => {
    installLocalStorage()
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    useUIStore.setState(uiInit, true)
  })

  it('SYA-C135 highlights the page a notification opens, also when Settings already shows another one', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })
    await act(async () => useUIStore.getState().openSettings('sync'))
    expect(current()).toBe('Sync')
    await act(async () => useUIStore.getState().openSettings('server'))
    expect(current()).toBe('Server')
    await act(async () => useUIStore.getState().openSettings('sync'))
    expect(current()).toBe('Sync')
  })
})
