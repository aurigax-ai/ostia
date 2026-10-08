import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const MIN_SHARPNESS = 0.7
const MIN_ICONS = 20

async function launch(scale: number) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'src'), { recursive: true })
  writeFileSync(join(home, 'index.ts'), 'export const one = 1\n')
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    args: [`--force-device-scale-factor=${scale}`, ...options.args],
    env: { ...options.env, HOME: home },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await expect(win.locator('.file-tree').getByRole('button', { name: 'index.ts' })).toBeVisible({
    timeout: 15_000,
  })
  await win.locator('.files-head').getByRole('button', { name: 'Search files' }).click()
  await expect(win.getByRole('textbox', { name: 'Search files' })).toBeFocused()
  return { app, win }
}

async function measureIcons(win: Page) {
  return win.evaluate(async () => {
    const scale = window.devicePixelRatio
    const icons = [
      ...document.querySelectorAll<SVGSVGElement>('svg[viewBox="0 0 256 256"]'),
    ].filter((svg) => svg.getBoundingClientRect().width > 0)
    const sharpness: number[] = []
    const fractionalSizes: string[] = []
    const shifted: string[] = []
    for (const svg of icons) {
      const box = svg.getBoundingClientRect()
      const name = `${svg.closest('[aria-label]')?.getAttribute('aria-label') ?? svg.parentElement?.className}`
      if (!Number.isInteger(box.width) || !Number.isInteger(box.height)) fractionalSizes.push(name)
      for (let el: Element | null = svg; el; el = el.parentElement) {
        const transform = getComputedStyle(el).transform
        if (transform === 'none') continue
        const matrix = new DOMMatrixReadOnly(transform)
        if (!Number.isInteger(matrix.e) || !Number.isInteger(matrix.f)) shifted.push(name)
      }
      const copy = svg.cloneNode(true) as SVGSVGElement
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      copy.setAttribute('width', String(box.width))
      copy.setAttribute('height', String(box.height))
      copy.removeAttribute('class')
      copy.removeAttribute('style')
      copy.setAttribute('fill', '#fff')
      const image = new Image()
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(box.width * scale)
      canvas.height = Math.round(box.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let ink = 0
      let solid = 0
      for (let i = 3; i < data.length; i += 4) {
        const coverage = data[i] / 255
        ink += coverage
        solid += coverage * coverage
      }
      if (ink > 0) sharpness.push(solid / ink)
    }
    return {
      scale,
      count: sharpness.length,
      sharpness: sharpness.reduce((sum, value) => sum + value, 0) / sharpness.length,
      fractionalSizes,
      shifted,
    }
  })
}

for (const scale of [1, 2]) {
  test(`icons are drawn sharp at display scale ${scale}`, async () => {
    test.setTimeout(90_000)
    const { app, win } = await launch(scale)
    try {
      const icons = await measureIcons(win)
      expect(icons.scale).toBe(scale)
      expect(icons.count).toBeGreaterThanOrEqual(MIN_ICONS)
      expect(icons.fractionalSizes).toEqual([])
      expect(icons.shifted).toEqual([])
      expect(icons.sharpness).toBeGreaterThanOrEqual(MIN_SHARPNESS)
    } finally {
      await app.close()
    }
  })
}
