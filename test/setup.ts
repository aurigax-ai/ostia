import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { makePineMock } from './mocks/pine'

/**
 * jsdom lacks a handful of browser APIs that shadcn/Base-UI, cmdk, and allotment reach for
 * at render time. Shim them once so component tests don't each re-polyfill. These are inert
 * for the store/logic tests that never touch them.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
    root = null
    rootMargin = ''
    thresholds = []
  } as unknown as typeof IntersectionObserver
}
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
// Base-UI's ScrollArea polls getAnimations on a timer; jsdom lacks it (would surface as a
// post-test unhandled rejection in any component that renders a ScrollArea, e.g. SettingsPanel).
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

/**
 * jsdom setup for the `dom` project: registers jest-dom matchers, unmounts React trees
 * between tests, and installs a fresh typed `window.pine` fake before each test so
 * renderer code (stores/components) can call the bridge without a real Electron preload.
 */
beforeEach(() => {
  vi.stubGlobal('pine', makePineMock())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
