import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { cancelSettingsSave } from '../src/renderer/stores/app/settingsPersist'
import { startConsoleGuard, stopConsoleGuard } from './consoleGuard'
import { installLocalStorage } from './mocks/memoryStorage'
import { makeOstiaMock } from './mocks/ostia'

configure({ asyncUtilTimeout: process.platform === 'darwin' ? 5_000 : 1_000 })

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
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext

if (!('OffscreenCanvas' in globalThis)) {
  globalThis.OffscreenCanvas = class {
    getContext(kind: string) {
      return kind === '2d' ? { font: '', measureText: () => ({ width: 0 }) } : null
    }
  } as unknown as typeof OffscreenCanvas
}

beforeEach(() => {
  startConsoleGuard()
  installLocalStorage()
  vi.stubGlobal('ostia', makeOstiaMock())
})

afterEach(() => {
  cleanup()
  cancelSettingsSave()
  vi.unstubAllGlobals()
  stopConsoleGuard()
})
