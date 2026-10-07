import { type ElectronApplication, type Locator, type Page, expect } from './test'

export const PROMPT = /[❯$%#]/

export function emptyState(win: Page): Locator {
  return win.locator('.workzone-empty')
}

export function emptyWorkspace(win: Page): Locator {
  return win.locator('.workspace-empty:visible')
}

export async function openWorkspace(win: Page): Promise<void> {
  const before = await win.locator('.xterm').count()
  await emptyState(win)
    .getByRole('button', { name: /New workspace/ })
    .click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.xterm')).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
}

export async function waitForPaletteSelection(win: Page, title: string): Promise<void> {
  const option = win.getByRole('option', { name: new RegExp(`^${escapeRegExp(title)}`) }).first()
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function waitForExit(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

async function dialogShown(win: Page): Promise<'asked' | null> {
  try {
    await win.getByRole('dialog').waitFor({ timeout: 30_000 })
    return 'asked'
  } catch {
    return null
  }
}

export async function pressQuit(app: ElectronApplication, win: Page): Promise<'quit' | 'asked'> {
  const exited = waitForExit(app).then(() => 'quit' as const)
  if (process.platform === 'darwin') {
    await app
      .evaluate(({ app: electronApp }) => {
        setTimeout(() => electronApp.quit(), 0)
      })
      .catch(() => {})
  } else {
    await win.evaluate(() => window.ostia.window.quit()).catch(() => {})
  }
  return Promise.race([exited, dialogShown(win).then((shown) => shown ?? exited)])
}
