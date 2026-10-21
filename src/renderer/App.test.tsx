import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { App } from './App'

vi.mock('@/lib/monaco/setup', () => ({ monaco: {} }))
vi.mock('@/lib/lsp/client', () => ({ startLanguageServices: vi.fn(async () => {}) }))
vi.mock('@/lib/monaco/contributedLanguages', () => ({ loadEditorLanguages: vi.fn(async () => {}) }))
vi.mock('@/lib/monaco/useMonacoTheme', () => ({ useMonacoTheme: () => {} }))
vi.mock('@/lib/settings/registerSettingsSchema', () => ({
  registerSettingsSchema: vi.fn(async () => {}),
}))

describe('App', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState(uiInit, true)
  })

  it('the Files button opens the Files panel and closes it again', async () => {
    const { container } = render(<App />)
    const user = userEvent.setup()
    const files = screen.getByRole('button', { name: 'Files' })
    expect(container.querySelector('.files-panel')).toBeNull()

    await user.click(files)
    expect(container.querySelector('.files-panel')).toBeInTheDocument()

    await user.click(files)
    expect(container.querySelector('.files-panel')).toBeNull()
  })
})
