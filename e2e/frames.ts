import type { Page } from './test'

export const SLOW_FRAME_MS = 1500

export async function slowFrames(win: Page): Promise<void> {
  await win.evaluate((delay) => {
    const raf = window.requestAnimationFrame.bind(window)
    Object.assign(window, { __fastFrames: raf })
    window.requestAnimationFrame = (cb) => window.setTimeout(() => raf(cb), delay)
  }, SLOW_FRAME_MS)
}

export async function fastFrames(win: Page): Promise<void> {
  await win.evaluate(() => {
    const raf = (window as unknown as { __fastFrames?: typeof requestAnimationFrame }).__fastFrames
    if (raf) window.requestAnimationFrame = raf
  })
}
