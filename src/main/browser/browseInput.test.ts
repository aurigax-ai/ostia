import { describe, expect, it, vi } from 'vitest'
import { createBrowseInput } from './browseInput'
import { isInjecting } from './guestInject'

function guest() {
  const seen: boolean[] = []
  const sendInputEvent = vi.fn(() => {
    seen.push(isInjecting(4))
  })
  return { target: { id: 4, sendInputEvent } as unknown as Electron.WebContents, seen }
}

describe('agent keys', () => {
  const input = createBrowseInput({ mousePositions: new Map() })

  it('are sent as injected events so the remap neither tracks nor rewrites them', () => {
    const { target, seen } = guest()
    input.sendCombo(
      target,
      { keyCode: 'Control', modifiers: ['control'], printable: false },
      'down',
    )
    input.typeText(target, 'a b')
    expect(seen.length).toBeGreaterThan(4)
    expect(seen.every(Boolean)).toBe(true)
    expect(isInjecting(4)).toBe(false)
  })
})
