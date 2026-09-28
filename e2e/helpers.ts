import { type Locator, type Page, expect } from '@playwright/test'

export const PROMPT = /[❯$%#]/

export function emptyState(win: Page): Locator {
  return win.locator('.workzone-empty')
}

export function emptyWorkspace(win: Page): Locator {
  return win.locator('.workspace-empty:visible')
}

export async function openWorkspace(win: Page): Promise<void> {
  const before = await win.locator('.xterm').count()
  await emptyState(win).getByRole('button', { name: /New workspace/ }).click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.xterm')).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
}
