import type { BellFlashEasing } from '@shared/app/notificationSettings'

export const BELL_FLASH_MIN_INTERVAL_MS = 334

const REMOVE_GRACE_MS = 60

export interface BellFlashRequest {
  enabled: boolean
  durationMs: number
  easing: BellFlashEasing
  color?: string
  reducedMotion: boolean
  now: number
}

interface BellFlash {
  flash: (request: BellFlashRequest) => boolean
  dispose: () => void
}

export function createBellFlash(container: HTMLElement): BellFlash {
  let last = Number.NEGATIVE_INFINITY
  let overlay: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    overlay?.remove()
    overlay = null
  }

  return {
    flash: ({ enabled, durationMs, easing, color, reducedMotion, now }) => {
      if (!enabled || reducedMotion) return false
      const quiet = now - last >= Math.max(durationMs, BELL_FLASH_MIN_INTERVAL_MS)
      last = now
      if (!quiet) return false
      clear()
      const el = container.ownerDocument.createElement('div')
      el.className = 'bell-flash'
      el.setAttribute('aria-hidden', 'true')
      el.style.setProperty('--bell-flash-ms', `${durationMs}ms`)
      el.dataset.easing = easing
      if (color) el.style.setProperty('--bell-flash-color', color)
      container.appendChild(el)
      overlay = el
      timer = setTimeout(clear, durationMs + REMOVE_GRACE_MS)
      return true
    },
    dispose: clear,
  }
}
