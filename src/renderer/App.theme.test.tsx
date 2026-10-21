import '@testing-library/jest-dom/vitest'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { renderSettled } from '../../test/render'
import { App } from './App'

vi.mock('@/lib/monaco/setup', () => ({ monaco: {} }))
vi.mock('@/lib/lsp/client', () => ({ startLanguageServices: vi.fn(async () => {}) }))
vi.mock('@/lib/monaco/contributedLanguages', () => ({ loadEditorLanguages: vi.fn(async () => {}) }))
vi.mock('@/lib/monaco/useMonacoTheme', () => ({ useMonacoTheme: () => {} }))
vi.mock('@/lib/settings/registerSettingsSchema', () => ({
  registerSettingsSchema: vi.fn(async () => {}),
}))

const brand = () => document.documentElement.style.getPropertyValue('--color-brand')

describe('App theme', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    document.documentElement.removeAttribute('style')
  })

  it('a custom accent color overrides the brand color on the window', async () => {
    await renderSettled(<App />)
    const themeBrand = brand()
    expect(themeBrand).not.toBe('#ff8800')

    act(() => {
      useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, accent: '#ff8800' } }))
    })
    expect(brand()).toBe('#ff8800')

    act(() => {
      useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, accent: '' } }))
    })
    expect(brand()).toBe(themeBrand)
  })
})
