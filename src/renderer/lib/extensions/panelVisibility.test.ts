import { onPanelVisibility } from '@aurigax-ai/ostia-extension-sdk/panel'
import { describe, expect, it } from 'vitest'

describe('onPanelVisibility', () => {
  it('PHT-C14 tells a panel page it was hidden when Ostia hides its slot or the window is hidden', () => {
    const seen: boolean[] = []
    onPanelVisibility((hidden) => seen.push(hidden))
    window.dispatchEvent(new CustomEvent('ostia-panel-visibility', { detail: { hidden: true } }))
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toEqual([true, true, false])
  })
})
