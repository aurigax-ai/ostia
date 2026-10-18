import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import type { FixtureName } from './hasFixtures'
import { type ElectronApplication, type Page, expect, launchShared, test } from './test'

let app: ElectronApplication | undefined
let win: Page
let fixtures: Record<FixtureName, string>

test.beforeAll(async () => {
  const bundle = join(test.info().outputPath(), 'has-fixtures.mjs')
  buildSync({
    entryPoints: [resolve(__dirname, 'hasFixtures.tsx')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bundle,
    logLevel: 'error',
  })
  fixtures = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: 'utf8' }))
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  app = await launchShared(isolatedLaunch(dataHome))
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.app')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  await app?.close()
})

async function mount(name: FixtureName): Promise<number> {
  return win.evaluate((markup) => {
    document.getElementById('has-fixtures')?.remove()
    const host = document.createElement('div')
    host.id = 'has-fixtures'
    host.style.cssText = 'position:fixed;left:0;top:0;width:640px;z-index:2147483647'
    host.innerHTML = markup
    document.body.append(host)
    const root = getComputedStyle(document.documentElement)
    return Number.parseFloat(root.getPropertyValue('--spacing')) * Number.parseFloat(root.fontSize)
  }, fixtures[name])
}

function style(probe: string, property: string): Promise<string> {
  return win.evaluate(
    ({ probe, property }) => {
      const el = document.querySelector(`[data-probe="${probe}"]`)
      if (!el) throw new Error(`no ${probe}`)
      return getComputedStyle(el).getPropertyValue(property)
    },
    { probe, property },
  )
}

async function px(probe: string, property: string): Promise<number> {
  return Number.parseFloat(await style(probe, property))
}

const SIDES = ['inline-start', 'inline-end'] as const

function iconInset(probe: string, side: (typeof SIDES)[number]): Promise<number> {
  return win.evaluate(
    ({ probe, side }) => {
      const host = document.querySelector<HTMLElement>(`[data-probe="${probe}"]`)
      const svg = host?.querySelector('svg')
      if (!host || !svg) throw new Error(`no ${probe}`)
      const outer = host.getBoundingClientRect()
      const inner = svg.getBoundingClientRect()
      const css = getComputedStyle(host)
      return side === 'inline-start'
        ? inner.left - outer.left - Number.parseFloat(css.borderLeftWidth)
        : outer.right - inner.right - Number.parseFloat(css.borderRightWidth)
    },
    { probe, side },
  )
}

const OLD_ICON_PADDING = [
  ['default', 2],
  ['xs', 1.5],
  ['sm', 1.5],
  ['lg', 2],
  ['badge', 1.5],
  ['tab', 1],
] as const

test('a button, badge or tab keeps the narrower padding on the side of its marked icon', async () => {
  const unit = await mount('buttons')
  for (const [size, units] of OLD_ICON_PADDING.slice(0, 4)) {
    for (const side of SIDES) {
      expect(await iconInset(`${size}-${side}`, side), `${size} ${side}`).toBeCloseTo(
        units * unit,
        1,
      )
    }
  }
  await mount('badgesAndTabs')
  for (const [kind, units] of OLD_ICON_PADDING.slice(4)) {
    for (const side of SIDES) {
      expect(await iconInset(`${kind}-${side}`, side), `${kind} ${side}`).toBeCloseTo(
        units * unit,
        1,
      )
    }
  }
})

test('an alert makes room for its action, and a caller can take that room back', async () => {
  const unit = await mount('alerts')
  expect(await px('plain', 'padding-right')).toBeCloseTo(2.5 * unit, 1)
  expect(await px('with-action', 'padding-right')).toBeCloseTo(18 * unit, 1)
  expect(await style('inline-action', 'padding-right')).toBe('0px')
})

test('a button group rounds the far corners of its last slotted child only', async () => {
  await mount('buttonGroups')
  const radius = await style('radius', 'border-top-left-radius')
  expect(radius).not.toBe('0px')
  expect(await style('horizontal-first', 'border-top-right-radius')).toBe('0px')
  expect(await style('horizontal-last', 'border-top-right-radius')).toBe(radius)
  expect(await style('horizontal-last', 'border-bottom-right-radius')).toBe(radius)
  expect(await style('vertical-first', 'border-bottom-left-radius')).toBe('0px')
  expect(await style('vertical-last', 'border-bottom-left-radius')).toBe(radius)
  expect(await style('vertical-last', 'border-bottom-right-radius')).toBe(radius)
})

test('an input group lays out around each kind of addon and rings when its field has focus', async () => {
  const unit = await mount('inputGroups')
  expect(await px('input-inline-start', 'padding-left')).toBeCloseTo(1.5 * unit, 1)
  expect(await px('input-inline-end', 'padding-right')).toBeCloseTo(1.5 * unit, 1)
  expect(await px('input-plain', 'padding-left')).toBeGreaterThan(1.5 * unit)
  expect(await px('input-plain', 'padding-right')).toBeGreaterThan(1.5 * unit)
  for (const align of ['block-start', 'block-end']) {
    expect(await style(`group-${align}`, 'flex-direction')).toBe('column')
    expect(await px(`group-${align}`, 'height')).toBeGreaterThan(8 * unit)
  }
  expect(await px('input-block-start', 'padding-bottom')).toBeCloseTo(3 * unit, 1)
  expect(await px('input-block-end', 'padding-top')).toBeCloseTo(3 * unit, 1)
  expect(await style('group-plain', 'flex-direction')).toBe('row')
  expect(await px('group-plain', 'height')).toBeCloseTo(8 * unit, 1)
  expect(await px('group-textarea', 'height')).toBeGreaterThan(8 * unit)

  expect(await style('group-plain', 'outline-style')).toBe('none')
  await win.locator('[data-probe="input-plain"]').focus()
  expect(await style('group-plain', 'outline-style')).toBe('solid')
  expect(await style('group-plain', 'outline-width')).toBe('2px')
})

test('an expanded table row is shaded and a collapsed one is not', async () => {
  await mount('tableRows')
  expect(await style('expanded', 'background-color')).toBe(await style('shade', 'background-color'))
  expect(await style('collapsed', 'background-color')).toBe('rgba(0, 0, 0, 0)')
})

test('a tooltip lets the pointer through to what lies under it', async () => {
  await win.evaluate(() => document.getElementById('has-fixtures')?.remove())
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).hover()
  const tooltip = win.locator('[data-slot="tooltip-content"]')
  await expect(tooltip).toBeVisible()
  const through = await tooltip.evaluate((el) => {
    const positioner = el.parentElement as HTMLElement
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return {
      popup: getComputedStyle(el).pointerEvents,
      positioner: getComputedStyle(positioner).pointerEvents,
      hitInside: hit !== null && positioner.contains(hit),
    }
  })
  expect(through).toEqual({ popup: 'none', positioner: 'none', hitInside: false })
  await win.mouse.move(0, 0)
})

test('the work zone follows the sidebar while it slides, and only then', async () => {
  const sliding = () =>
    win.evaluate(() => {
      const app = document.querySelector('.app') as HTMLElement
      const zone = document.querySelector('.workzone') as HTMLElement
      return {
        overflow: getComputedStyle(app).overflow,
        follow: getComputedStyle(zone).animationName,
        willChange: getComputedStyle(zone).willChange,
      }
    })
  const still = await sliding()
  expect(still.follow).toBe('none')
  expect(still.overflow).not.toBe('clip')
  await win.locator('.topbar').getByRole('button', { name: 'Toggle sidebar' }).click()
  expect(await sliding()).toEqual({
    overflow: 'clip',
    follow: 'rail-follow',
    willChange: 'transform',
  })
  await expect.poll(sliding, { timeout: 5_000 }).toEqual(still)
})
