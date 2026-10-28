import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from '../chords'
import { freshDataHome, seedSettings, testHome } from '../dataHome'
import { openWorkspace, quitApp } from '../helpers'
import { expect, test } from '../test'
import { launchPlain, measure } from './flowApp'
import { RUNS, Samples, WARMUP } from './flowResults'

const SETTINGS = { behavior: { gpuAcceleration: false }, workspaces: { confirmQuit: false } }

test('bench ui: palette and settings open to painted', async () => {
  test.setTimeout(300_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const { app, win } = await launchPlain(dataHome)
  const samples = new Samples()
  try {
    await openWorkspace(win)
    for (let i = 0; i < RUNS + WARMUP; i++) {
      const palette = await measure(win, {
        start: { type: 'keydown', key: 'p' },
        ends: { open: [{ sel: '[role="dialog"] [role="option"][aria-selected="true"]' }] },
        act: () => win.keyboard.press(chords.palette),
      })
      await win.keyboard.press('Escape')
      await expect(win.getByRole('dialog')).toHaveCount(0)
      const settings = await measure(win, {
        start: { type: 'keydown', key: ',' },
        ends: { open: [{ sel: 'section[aria-label="Settings"]' }] },
        act: () => win.keyboard.press(chords.openSettings),
      })
      const tab = win.locator('.rail-tab').filter({ hasText: 'Settings' })
      await tab.hover()
      await tab.getByRole('button', { name: 'Close' }).click()
      await expect(win.getByRole('region', { name: 'Settings' })).toHaveCount(0)
      if (i < WARMUP) continue
      samples.add('palette.open', palette.open)
      samples.add('settings.open', settings.open)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})

test('bench ui: file from the Files tree to editor text', async () => {
  test.setTimeout(300_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const files = Array.from({ length: RUNS + WARMUP + 1 }, (_, i) => `flow-file-${i}.txt`)
  for (const [i, name] of files.entries()) {
    writeFileSync(join(testHome(dataHome), name), `flow-content-${i}\n`.repeat(200))
  }
  const { app, win } = await launchPlain(dataHome)
  const samples = new Samples()
  try {
    await openWorkspace(win)
    const toggle = win.locator('.topbar').getByRole('button', { name: 'Files' })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    const tree = win.locator('.file-tree')
    for (const [i, name] of files.entries()) {
      const row = tree.getByRole('button', { name })
      await expect(row).toBeVisible({ timeout: 15_000 })
      const got = await measure(win, {
        start: { type: 'click', sel: '.file-tree' },
        ends: { open: [{ sel: '.monaco-editor .view-lines', text: `flow-content-${i}` }] },
        act: () => row.click(),
      })
      await win.keyboard.press(chords.closePane)
      await expect(win.locator('.monaco-editor')).toHaveCount(0, { timeout: 15_000 })
      if (i === 0) samples.add('file.open-editor-cold', got.open)
      else if (i > WARMUP) samples.add('file.open-editor', got.open)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})
