import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function openSettings(win: Page, section: string) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: section }).click()
  return settings
}

async function typeInTerminal(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

test('risky paste asks first; Cancel pastes nothing and Paste runs the text', async () => {
  const { app, win } = await launch()
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo pinecancelled\n'))
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+V')

    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Text to paste')).toContainText('echo pinecancelled')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await win.waitForTimeout(500)
    await expect(win.locator('.xterm-rows').first()).not.toContainText('pinecancelled')

    await app.evaluate(({ clipboard }) => clipboard.writeText('echo pinepasted42\n'))
    await win.keyboard.press('Control+Shift+V')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Paste' }).click()
    await win.keyboard.press('Enter')
    await expect(
      win.locator('.xterm-rows div', { hasText: /^pinepasted42\s*$/ }).first(),
    ).toBeAttached({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('a single-line paste goes straight in, and the warning can be turned off', async () => {
  const { app, win } = await launch()
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo pineplain'))
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+V')
    await expect(win.locator('.xterm-rows').first()).toContainText('echo pineplain')
    await expect(win.getByRole('dialog')).toHaveCount(0)

    const settings = await openSettings(win, 'Terminal')
    await settings.getByRole('switch', { name: 'Warn before risky paste' }).click()
    await win.keyboard.press('Escape')
    await app.evaluate(({ clipboard }) => clipboard.writeText('\necho pinequiet77\n'))
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+V')
    await expect(win.getByRole('dialog')).toHaveCount(0)
    await win.keyboard.press('Enter')
    await expect(
      win.locator('.xterm-rows div', { hasText: /^pinequiet77\s*$/ }).first(),
    ).toBeAttached({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('lowering scrollback in Settings trims history in an open terminal', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    await typeInTerminal(win, 'clear; seq 1 2000; echo scrolldone')
    await expect(win.locator('.xterm-rows').first()).toContainText('scrolldone', {
      timeout: 15_000,
    })

    const topLine = async (): Promise<number> => {
      const box = await win.locator('.xterm').first().boundingBox()
      if (!box) throw new Error('terminal has no box')
      await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (let i = 0; i < 40; i++) await win.mouse.wheel(0, -20_000)
      await win.waitForTimeout(300)
      const text = await win.locator('.xterm-rows').first().innerText()
      const first = text.split('\n').find((l) => /^\d+\s*$/.test(l.trim()))
      return Number(first?.trim())
    }

    await expect.poll(topLine, { timeout: 60_000 }).toBeLessThan(50)

    const settings = await openSettings(win, 'Terminal')
    await settings.getByRole('spinbutton', { name: 'Scrollback lines' }).fill('1000')
    await win.keyboard.press('Escape')
    await expect.poll(topLine, { timeout: 60_000 }).toBeGreaterThan(900)
  } finally {
    await app.close()
  }
})

test('Dim inactive panes turns the split pane dimming off', async () => {
  const { app, win } = await launch()
  try {
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.pane.dimmed')).toHaveCount(1)

    const settings = await openSettings(win, 'Panes')
    await settings.getByRole('switch', { name: 'Dim inactive panes' }).click()
    await expect(win.locator('.pane.dimmed')).toHaveCount(0)
    await settings.getByRole('switch', { name: 'Dim inactive panes' }).click()
    await expect(win.locator('.pane.dimmed')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('Focus pane on hover activates a pane the pointer rests on', async () => {
  const { app, win } = await launch()
  try {
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.xterm-rows').nth(1)).toContainText(PROMPT, { timeout: 15_000 })
    const left = win.locator('.pane').first()
    const right = win.locator('.pane').nth(1)
    await expect(right).toHaveClass(/active/)

    await left.hover()
    await win.waitForTimeout(600)
    await expect(right).toHaveClass(/active/)

    const settings = await openSettings(win, 'Panes')
    await settings.getByRole('switch', { name: 'Focus pane on hover' }).click()
    await win.keyboard.press('Escape')
    await right.hover()
    await left.hover()
    await expect(left).toHaveClass(/active/)
    await expect(right).not.toHaveClass(/active/)
  } finally {
    await app.close()
  }
})
