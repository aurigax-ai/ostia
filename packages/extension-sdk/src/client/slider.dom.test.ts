import { describe, expect, it, vi } from 'vitest'
import { createSlider } from './slider'

describe('createSlider', () => {
  it('fills its track to the value and reports input', () => {
    const onInput = vi.fn()
    const slider = createSlider({
      label: 'Seek',
      min: 0,
      max: 200,
      value: 50,
      format: (value) => `${value} s`,
      onInput,
    })
    expect(slider.element.getAttribute('aria-label')).toBe('Seek')
    expect(slider.element.style.getPropertyValue('--fill')).toBe('25%')
    expect(slider.element.getAttribute('aria-valuetext')).toBe('50 s')
    slider.element.value = '100'
    slider.element.dispatchEvent(new Event('input'))
    expect(onInput).toHaveBeenCalledWith(100)
    expect(slider.element.style.getPropertyValue('--fill')).toBe('50%')
    slider.setMax(400)
    expect(slider.element.style.getPropertyValue('--fill')).toBe('25%')
    slider.setValue(400)
    expect(slider.element.style.getPropertyValue('--fill')).toBe('100%')
  })

  it('shows an empty track for an empty range', () => {
    const slider = createSlider({ label: 'Volume', min: 0, max: 0, value: 0, onInput: () => {} })
    expect(slider.element.style.getPropertyValue('--fill')).toBe('0%')
  })
})
