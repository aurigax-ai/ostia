import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { closeAllWorkspaces, openWorkspace } from './helpers'
import { type ElectronApplication, type Page, expect, launchShared, test } from './test'

const RIGHT_EDGE_MAX = 16

async function rows(win: Page) {
  await win.waitForFunction(() => {
    const list = document.querySelector('[data-slot="command-list"]')
    const popup = list?.closest<HTMLElement>('[data-slot="dialog-content"]')
    if (!popup) return false
    const style = getComputedStyle(popup)
    return (
      !popup.hasAttribute('data-starting-style') &&
      style.transform === 'none' &&
      style.opacity === '1'
    )
  })
  return win.evaluate(() => {
    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement
    const listRect = list.getBoundingClientRect()
    const rowEls = [...document.querySelectorAll('[data-slot="palette-row"]')] as HTMLElement[]
    const measured = rowEls.map((row) => {
      const name = row.querySelector('[data-slot="palette-name"]') as HTMLElement
      const keys = row.querySelector<HTMLElement>('[data-slot="palette-keys"]')
      const meta = row.querySelector<HTMLElement>('[data-slot="palette-meta"]')
      const trailing = row.querySelector<HTMLElement>('[data-slot="palette-trailing"]')
      const text = document.createRange()
      text.selectNodeContents(name)
      const textRect = text.getBoundingClientRect()
      const nameRect = name.getBoundingClientRect()
      const trailingRect = trailing?.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      return {
        edge: trailingRect ? Math.round(rowRect.right - trailingRect.right) : null,
        afterTitle: trailingRect ? trailingRect.left >= textRect.right : true,
        hasKeys: keys !== null,
        keysDimmer: keys ? getComputedStyle(keys).color !== getComputedStyle(name).color : true,
        sameLine: trailingRect ? Math.abs(trailingRect.top - nameRect.top) < 20 : true,
        inside: (trailingRect ?? nameRect).right <= listRect.right + 0.5,
        metaCut: meta ? meta.scrollWidth > meta.clientWidth : false,
        titleCut: textRect.width > nameRect.width + 0.01,
      }
    })
    return {
      count: measured.length,
      edges: measured.map((r) => r.edge).filter((edge): edge is number => edge !== null),
      keyed: measured.filter((r) => r.hasKeys).length,
      afterTitle: measured.every((r) => r.afterTitle),
      keysDimmer: measured.every((r) => r.keysDimmer),
      sameLine: measured.every((r) => r.sameLine),
      inside: measured.every((r) => r.inside),
      metaCut: measured.filter((r) => r.metaCut).length,
      titleCut: measured.filter((r) => r.titleCut).length,
    }
  })
}

function expectTrailing(found: Awaited<ReturnType<typeof rows>>): void {
  expect(found.sameLine).toBe(true)
  expect(found.inside).toBe(true)
  expect(found.afterTitle).toBe(true)
  expect(found.keysDimmer).toBe(true)
  expect(found.titleCut).toBe(0)
  for (const edge of found.edges) {
    expect(edge).toBeGreaterThanOrEqual(0)
    expect(edge).toBeLessThanOrEqual(RIGHT_EDGE_MAX)
  }
}

let app: ElectronApplication | undefined
let win: Page

test.beforeAll(async () => {
  const dataHome = freshDataHome()
  const deep = join(dataHome, ...Array(4).fill('a-rather-long-folder-name-for-the-palette-row'))
  mkdirSync(deep, { recursive: true })
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      groups: [],
      workspaces: [
        {
          id: 's1',
          name: 'deep',
          kind: 'terminal',
          workDir: deep,
          root: { type: 'pane', id: 'pane-1', title: 'shell', kind: 'terminal', cwd: deep },
          activePaneId: 'pane-1',
        },
      ],
    }),
  )
  app = await launchShared(isolatedLaunch(dataHome))
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.rail-tab').filter({ hasText: 'deep' })).toBeVisible({
    timeout: 15_000,
  })
})

test.afterAll(async () => {
  await app?.close()
})

test('a long workspace path is cut short inside its row and the names stay whole', async () => {
  await win.keyboard.press(chords.palette)
  const palette = win.getByRole('dialog', { name: 'Command palette' })
  await expect(palette.getByRole('combobox')).toHaveValue('>')
  await palette.getByRole('combobox').fill('')
  await expect(palette.getByRole('option', { name: /deep/ }).first()).toBeVisible()

  const all = await rows(win)
  expect(all.edges.length).toBeGreaterThan(1)
  expect(all.metaCut).toBeGreaterThan(0)
  expectTrailing(all)

  await palette.getByRole('combobox').fill('@deep')
  await expect(palette.getByRole('option', { name: /deep/ }).first()).toBeVisible()
  const workspaces = await rows(win)
  expect(workspaces.metaCut).toBeGreaterThan(0)
  expectTrailing(workspaces)
  await win.keyboard.press('Escape')
  await expect(palette).toBeHidden()
})

test('each palette row shows its keycap and id at the right edge, the keycap dimmer, with and without a query', async () => {
  await closeAllWorkspaces(win)
  await openWorkspace(win)
  await win.keyboard.press(chords.palette)
  const palette = win.getByRole('dialog', { name: 'Command palette' })
  await expect(palette.getByRole('combobox')).toHaveValue('>')
  await expect(palette.getByRole('option').first()).toBeVisible()

  const all = await rows(win)
  expect(all.count).toBeGreaterThan(1)
  expect(all.keyed).toBeGreaterThan(1)
  expect(all.edges.length).toBeGreaterThan(1)
  expectTrailing(all)

  await palette.getByRole('combobox').fill('pane')
  await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
  const searched = await rows(win)
  expect(searched.count).toBeGreaterThan(1)
  expect(searched.keyed).toBeGreaterThan(0)
  expectTrailing(searched)
})
