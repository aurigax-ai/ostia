import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const MIN_ICONS = 20
const PHOSPHOR = resolve(__dirname, '../node_modules/@phosphor-icons/core/assets')
const WEIGHTS = ['regular', 'bold'] as const
type Weight = (typeof WEIGHTS)[number]

interface MountedIcon {
  paths: string
  markup: string
  width: number
  height: number
}

function pathKey(markup: string): string {
  return [...markup.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1]).join(' ')
}

function phosphorAssets() {
  const byName = new Map<string, Record<Weight, string>>()
  const nameByPaths = new Map<string, { name: string; weight: Weight }>()
  for (const file of readdirSync(join(PHOSPHOR, 'regular'))) {
    const name = file.replace(/\.svg$/, '')
    const markup = {
      regular: readFileSync(join(PHOSPHOR, 'regular', file), 'utf8'),
      bold: readFileSync(join(PHOSPHOR, 'bold', `${name}-bold.svg`), 'utf8'),
    }
    byName.set(name, markup)
    for (const weight of WEIGHTS) nameByPaths.set(pathKey(markup[weight]), { name, weight })
  }
  return { byName, nameByPaths }
}

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
  await win.locator('#files-panel').getByRole('button', { name: 'Search', exact: true }).click()
  await expect(win.getByRole('textbox', { name: 'Search files' })).toBeFocused()
  return { app, win }
}

async function measureIcons(win: Page) {
  return win.evaluate(() => {
    const scale = window.devicePixelRatio
    const onDevicePixel = (value: number): boolean =>
      Math.abs(value * scale - Math.round(value * scale)) < 0.01
    const length = (value: string, reference: number): number =>
      value.endsWith('%') ? (Number.parseFloat(value) / 100) * reference : Number.parseFloat(value)
    const borderBox = (style: CSSStyleDeclaration, axis: 'width' | 'height'): number => {
      const size = Number.parseFloat(style[axis]) || 0
      if (style.boxSizing === 'border-box') return size
      const sides = axis === 'width' ? ['left', 'right'] : ['top', 'bottom']
      return sides
        .flatMap((side) => [`padding-${side}`, `border-${side}-width`])
        .reduce((sum, key) => sum + (Number.parseFloat(style.getPropertyValue(key)) || 0), size)
    }
    const rotation = (value: string): string => {
      const parts = value.split(' ')
      if (parts.length === 1) return `rotate(${value})`
      if (parts.length === 2) return `rotate${parts[0].toUpperCase()}(${parts[1]})`
      return `rotate3d(${parts.join(', ')})`
    }
    const scaling = (value: string): string => {
      const parts = value.split(' ').map((part) => length(part, 1))
      return `scale3d(${parts[0]}, ${parts[1] ?? parts[0]}, ${parts[2] ?? 1})`
    }
    const ownOffset = (el: Element): { x: number; y: number } => {
      const style = getComputedStyle(el)
      const { translate, rotate, scale: scaleProperty, transform } = style
      if ([translate, rotate, scaleProperty, transform].every((value) => value === 'none')) {
        return { x: 0, y: 0 }
      }
      const [originX, originY] = style.transformOrigin.split(' ').map(Number.parseFloat)
      const matrix = new DOMMatrix().translateSelf(originX, originY)
      if (translate !== 'none') {
        const [x, y = '0px'] = translate.split(' ')
        matrix.translateSelf(
          length(x, borderBox(style, 'width')),
          length(y, borderBox(style, 'height')),
        )
      }
      if (rotate !== 'none') matrix.multiplySelf(new DOMMatrix(rotation(rotate)))
      if (scaleProperty !== 'none') matrix.multiplySelf(new DOMMatrix(scaling(scaleProperty)))
      if (transform !== 'none') matrix.multiplySelf(new DOMMatrix(transform))
      matrix.translateSelf(-originX, -originY)
      return { x: matrix.e, y: matrix.f }
    }
    const icons = [
      ...document.querySelectorAll<SVGSVGElement>('svg[viewBox="0 0 256 256"]'),
    ].filter((svg) => svg.getBoundingClientRect().width > 0)
    const fractionalSizes: string[] = []
    const shifted: string[] = []
    const mounted: MountedIcon[] = []
    for (const svg of icons) {
      const box = svg.getBoundingClientRect()
      const name = `${svg.closest('[aria-label]')?.getAttribute('aria-label') ?? svg.parentElement?.className}`
      if (!Number.isInteger(box.width) || !Number.isInteger(box.height)) fractionalSizes.push(name)
      let x = 0
      let y = 0
      for (let el: Element | null = svg; el; el = el.parentElement) {
        const offset = ownOffset(el)
        x += offset.x
        y += offset.y
      }
      if (!onDevicePixel(x) || !onDevicePixel(y)) shifted.push(name)
      const copy = svg.cloneNode(true) as SVGSVGElement
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      mounted.push({
        paths: [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')).join(' '),
        markup: new XMLSerializer().serializeToString(copy),
        width: box.width,
        height: box.height,
      })
    }
    return { scale, mounted, fractionalSizes, shifted }
  })
}

async function sharpness(win: Page, icons: Omit<MountedIcon, 'paths'>[]): Promise<number> {
  const values = await win.evaluate(async (list) => {
    const scale = window.devicePixelRatio
    const results: number[] = []
    for (const { markup, width, height } of list) {
      const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
      svg.setAttribute('width', String(width))
      svg.setAttribute('height', String(height))
      svg.removeAttribute('class')
      svg.removeAttribute('style')
      svg.setAttribute('fill', '#fff')
      const image = new Image()
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
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
      if (ink > 0) results.push(solid / ink)
    }
    return results
  }, icons)
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

for (const scale of [1, 2]) {
  test(`icons are drawn sharp at display scale ${scale}`, async () => {
    test.setTimeout(120_000)
    const { byName, nameByPaths } = phosphorAssets()
    const { app, win } = await launch(scale)
    try {
      const icons = await measureIcons(win)
      expect(icons.scale).toBe(scale)
      expect(icons.mounted.length).toBeGreaterThanOrEqual(MIN_ICONS)
      expect(icons.fractionalSizes).toEqual([])
      expect(icons.shifted).toEqual([])
      const matched = icons.mounted.flatMap((icon) => {
        const match = nameByPaths.get(icon.paths)
        const markup = match && byName.get(match.name)
        return match && markup ? [{ icon, weight: match.weight, markup }] : []
      })
      const used = new Set(matched.map((entry) => entry.weight))
      const mean: Record<'app' | Weight, number> = {
        app: await sharpness(win, icons.mounted),
        regular: 0,
        bold: 0,
      }
      for (const weight of WEIGHTS) {
        mean[weight] = await sharpness(
          win,
          matched.map(({ icon, markup }) => ({ ...icon, markup: markup[weight] })),
        )
      }
      const threshold = (mean.regular + mean.bold) / 2
      console.log(
        `icon sharpness ${scale}x: ${icons.mounted.length} icons, ${matched.length} Phosphor (${[...used].join(', ')}); app ${mean.app.toFixed(3)}, regular ${mean.regular.toFixed(3)}, bold ${mean.bold.toFixed(3)}, threshold ${threshold.toFixed(3)}`,
      )
      expect(matched.length).toBeGreaterThanOrEqual(MIN_ICONS)
      expect(mean.app).toBeGreaterThanOrEqual(threshold)
    } finally {
      await app.close()
    }
  })
}

test('an icon under a fractional translate fails the offset check', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launch(1)
  try {
    await win.evaluate(() => {
      const icon = document.querySelector('svg[viewBox="0 0 256 256"]')
      if (!icon) return
      for (const [label, translate] of [
        ['half pixel', '0.5px 0'],
        ['half of an odd height', '0 -50%'],
        ['whole pixel', '1px 0'],
      ]) {
        const box = document.createElement('div')
        box.setAttribute('aria-label', label)
        box.style.cssText = `position: fixed; left: 0; top: 0; width: 16px; height: 17px; translate: ${translate}`
        const copy = icon.cloneNode(true) as SVGSVGElement
        copy.removeAttribute('aria-label')
        copy.setAttribute('width', '16')
        copy.setAttribute('height', '16')
        box.append(copy)
        document.body.append(box)
      }
    })
    const { shifted } = await measureIcons(win)
    expect(shifted).toEqual(expect.arrayContaining(['half pixel', 'half of an odd height']))
    expect(shifted).not.toContain('whole pixel')
  } finally {
    await app.close()
  }
})
