import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function columns(win: Page) {
  return win.evaluate(() => {
    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement
    const listRect = list.getBoundingClientRect()
    const rows = [...document.querySelectorAll('[data-slot="palette-row"]')].map((row) => {
      const name = row.querySelector('[data-slot="palette-name"]') as HTMLElement
      const keys = row.querySelector('[data-slot="palette-keys"]') as HTMLElement
      const meta = row.querySelector('[data-slot="palette-meta"]') as HTMLElement
      const nameRect = name.getBoundingClientRect()
      const keysRect = keys.getBoundingClientRect()
      const metaRect = meta.getBoundingClientRect()
      return {
        nameRight: nameRect.left + name.scrollWidth,
        keysLeft: keys.getBoundingClientRect().left,
        hasKeys: keys.childElementCount > 0,
        metaRight: metaRect.right,
        metaClear: metaRect.left >= keysRect.right - 0.5 && metaRect.right <= listRect.right + 0.5,
        metaCut: meta.scrollWidth > meta.clientWidth,
        sameLine: Math.abs(keysRect.top - nameRect.top) < 20,
      }
    })
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
    const widest = rows.reduce((a, b) => (b.nameRight > a.nameRight ? b : a))
    return {
      count: rows.length,
      keyed: rows.filter((r) => r.hasKeys).length,
      sameLine: rows.every((r) => r.sameLine),
      metaClear: rows.every((r) => r.metaClear),
      metaCut: rows.filter((r) => r.metaCut).length,
      keysLeftSpread: spread(rows.map((r) => r.keysLeft)),
      metaRightSpread: spread(rows.map((r) => r.metaRight)),
      widestGap: widest.keysLeft - widest.nameRight,
      keysWithinHalf: rows.every((r) => r.keysLeft - listRect.left <= listRect.width * 0.7),
    }
  })
}

test('the palette lines keycaps up in one column right after the names and secondary text up at the right edge, with and without a query', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('option').first()).toBeVisible()

    const all = await columns(win)
    expect(all.count).toBeGreaterThan(1)
    expect(all.keyed).toBeGreaterThan(1)
    expect(all.sameLine).toBe(true)
    expect(all.metaClear).toBe(true)
    expect(all.keysLeftSpread).toBeLessThanOrEqual(1)
    expect(all.metaRightSpread).toBeLessThanOrEqual(1)
    expect(all.widestGap).toBeLessThanOrEqual(24)
    expect(all.keysWithinHalf).toBe(true)

    await palette.getByRole('combobox').fill('pane')
    await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
    const searched = await columns(win)
    expect(searched.count).toBeGreaterThan(1)
    expect(searched.metaClear).toBe(true)
    expect(searched.keysLeftSpread).toBeLessThanOrEqual(1)
    expect(searched.metaRightSpread).toBeLessThanOrEqual(1)
    expect(searched.widestGap).toBeLessThanOrEqual(24)
  } finally {
    await app.close()
  }
})

test('a long workspace path is cut short instead of spilling over the keycaps and names', async () => {
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
    await expect(palette.getByRole('option', { name: /deep/ }).first()).toBeVisible()

    const all = await columns(win)
    expect(all.keyed).toBeGreaterThan(1)
    expect(all.metaClear).toBe(true)
    expect(all.metaCut).toBeGreaterThan(0)
    expect(all.keysLeftSpread).toBeLessThanOrEqual(1)

    await palette.getByRole('combobox').fill('@deep')
    await expect(palette.getByRole('option', { name: /deep/ }).first()).toBeVisible()
    const workspaces = await columns(win)
    expect(workspaces.metaClear).toBe(true)
    expect(workspaces.metaCut).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
