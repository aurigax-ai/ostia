import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const TITLE_GAP_MAX = 12.5

async function rows(win: Page) {
  return win.evaluate(() => {
    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement
    const listRect = list.getBoundingClientRect()
    const rowEls = [...document.querySelectorAll('[data-slot="palette-row"]')] as HTMLElement[]
    const measured = rowEls.map((row) => {
      const name = row.querySelector('[data-slot="palette-name"]') as HTMLElement
      const keys = row.querySelector<HTMLElement>('[data-slot="palette-keys"]')
      const meta = row.querySelector<HTMLElement>('[data-slot="palette-meta"]')
      const text = document.createRange()
      text.selectNodeContents(name)
      const textRect = text.getBoundingClientRect()
      const nameRect = name.getBoundingClientRect()
      const keysRect = keys?.getBoundingClientRect()
      const metaRect = meta?.getBoundingClientRect()
      const before = keysRect ?? nameRect
      return {
        keyGap: keysRect ? keysRect.left - textRect.right : null,
        keysDimmer: keys ? getComputedStyle(keys).color !== getComputedStyle(name).color : true,
        sameLine: keysRect ? Math.abs(keysRect.top - nameRect.top) < 20 : true,
        metaGap: metaRect ? metaRect.left - before.right : null,
        inside: (metaRect ?? before).right <= listRect.right + 0.5,
        metaCut: meta ? meta.scrollWidth > meta.clientWidth : false,
        titleCut: textRect.width > nameRect.width + 0.01,
      }
    })
    const gaps = (key: 'keyGap' | 'metaGap') =>
      measured.map((r) => r[key]).filter((gap): gap is number => gap !== null)
    return {
      count: measured.length,
      keyGaps: gaps('keyGap'),
      metaGaps: gaps('metaGap'),
      keysDimmer: measured.every((r) => r.keysDimmer),
      sameLine: measured.every((r) => r.sameLine),
      inside: measured.every((r) => r.inside),
      metaCut: measured.filter((r) => r.metaCut).length,
      titleCut: measured.filter((r) => r.titleCut).length,
    }
  })
}

function expectInline(found: Awaited<ReturnType<typeof rows>>): void {
  expect(found.sameLine).toBe(true)
  expect(found.inside).toBe(true)
  expect(found.keysDimmer).toBe(true)
  expect(found.titleCut).toBe(0)
  for (const gap of found.keyGaps) {
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThanOrEqual(TITLE_GAP_MAX)
  }
  for (const gap of found.metaGaps) {
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThanOrEqual(TITLE_GAP_MAX)
  }
}

test('each palette row shows its keycap directly after its title, dimmer, then the secondary text, with and without a query', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('option').first()).toBeVisible()

    const all = await rows(win)
    expect(all.count).toBeGreaterThan(1)
    expect(all.keyGaps.length).toBeGreaterThan(1)
    expect(all.metaGaps.length).toBeGreaterThan(1)
    expectInline(all)

    await palette.getByRole('combobox').fill('pane')
    await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
    const searched = await rows(win)
    expect(searched.count).toBeGreaterThan(1)
    expect(searched.keyGaps.length).toBeGreaterThan(0)
    expectInline(searched)
  } finally {
    await app.close()
  }
})

test('a long workspace path is cut short inside its row and the names stay whole', async () => {
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
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByText('deep').first()).toBeVisible({ timeout: 15_000 })
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox').fill('')
    await expect(palette.getByRole('option', { name: /deep/ }).first()).toBeVisible()

    const all = await rows(win)
    expect(all.keyGaps.length).toBeGreaterThan(1)
    expect(all.metaCut).toBeGreaterThan(0)
    expectInline(all)

    await palette.getByRole('combobox').fill('@deep')
    await expect(palette.getByRole('option', { name: /deep/ }).first()).toBeVisible()
    const workspaces = await rows(win)
    expect(workspaces.metaCut).toBeGreaterThan(0)
    expectInline(workspaces)
  } finally {
    await app.close()
  }
})
