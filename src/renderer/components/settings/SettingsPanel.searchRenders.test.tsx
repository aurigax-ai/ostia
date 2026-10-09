import '@testing-library/jest-dom/vitest'
import { useUIStore } from '@/stores/uiStore'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const renders = new Map<string, number>()

vi.mock('./SettingsSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SettingsSearch')>()
  return {
    ...actual,
    useSearchRow: (texts: readonly (string | null | undefined)[]) => {
      const label = String(texts[0])
      renders.set(label, (renders.get(label) ?? 0) + 1)
      return actual.useSearchRow(texts)
    },
  }
})

import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const QUERY = 'blink'
const ROW = 'Copy on select'
const MOUNT_AND_MATCH_FLIPS = 3

describe('SettingsPanel search renders', () => {
  beforeAll(() => {
    Object.assign(window, { queryLocalFonts: async () => [] })
  })

  afterEach(() => {
    cleanup()
    renders.clear()
    useUIStore.setState({ settingsActive: false, settingsTabOpen: false })
  })

  it('re-renders a row that does not match the query only when its own match flips', async () => {
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
    render(<SettingsPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Search settings' }))

    await user.type(screen.getByRole('textbox', { name: 'Search settings' }), QUERY)

    expect(QUERY).toHaveLength(5)
    expect(screen.getByRole('textbox', { name: 'Search settings' })).toHaveValue(QUERY)
    expect(renders.get(ROW)).toBeLessThanOrEqual(MOUNT_AND_MATCH_FLIPS)
  })
})
