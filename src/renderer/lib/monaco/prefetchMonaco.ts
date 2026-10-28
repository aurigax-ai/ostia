import { loadMonaco } from './monacoLoader'

export const QUIET_BEFORE_PREFETCH_MS = 1000
const INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const

export function prefetchMonacoWhenQuiet(): void {
  let lastInput = performance.now()
  const noteInput = (): void => {
    lastInput = performance.now()
  }
  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, noteInput, { capture: true, passive: true })
  }
  const check = (): void => {
    const wait = QUIET_BEFORE_PREFETCH_MS - (performance.now() - lastInput)
    if (wait > 0) {
      setTimeout(check, wait)
      return
    }
    requestIdleCallback(() => {
      for (const type of INPUT_EVENTS) window.removeEventListener(type, noteInput, true)
      void loadMonaco()
    })
  }
  check()
}
