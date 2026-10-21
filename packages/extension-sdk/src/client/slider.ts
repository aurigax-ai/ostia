import { h } from './panel'

export interface SliderOptions {
  label: string
  min: number
  max: number
  value: number
  step?: number
  format?: (value: number) => string
  onInput: (value: number) => void
}

export interface Slider {
  element: HTMLInputElement
  setValue: (value: number) => void
  setMax: (max: number) => void
}

export function createSlider(options: SliderOptions): Slider {
  const element = h('input', {
    type: 'range',
    class: 'ostia-slider',
    'aria-label': options.label,
    min: String(options.min),
    max: String(options.max),
    step: String(options.step ?? 1),
  }) as HTMLInputElement
  const paint = (): void => {
    const span = Number(element.max) - Number(element.min)
    const fraction = span > 0 ? (Number(element.value) - Number(element.min)) / span : 0
    element.style.setProperty('--fill', `${Math.min(Math.max(fraction, 0), 1) * 100}%`)
    if (options.format)
      element.setAttribute('aria-valuetext', options.format(Number(element.value)))
  }
  element.value = String(options.value)
  element.addEventListener('input', () => {
    paint()
    options.onInput(Number(element.value))
  })
  paint()
  return {
    element,
    setValue: (value) => {
      element.value = String(value)
      paint()
    },
    setMax: (max) => {
      element.max = String(max)
      paint()
    },
  }
}
