import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, type Page, test } from './test'

const MIN_TEXT_WIDTH = 384

const ROWS = [
  { section: 'Privacy', label: 'Install id' },
  { section: 'Remote', label: 'Connection method' },
  { section: 'Appearance', label: 'Window title' },
  { section: 'About', label: 'Check for updates automatically' },
]

const WINDOW_WIDTHS = [1280, 720]

async function measure(
  win: Page,
  section: string,
  label: string,
): Promise<{ text: number; row: number }> {
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('navigation').getByRole('button', { name: section }).click()
  const row = settings
    .locator('[data-settings-row]')
    .filter({ has: win.getByText(label, { exact: true }) })
  const text = row.locator('[data-settings-row-text]')
  await expect(text).toBeVisible()
  return row.evaluate((el) => ({
    text: el.querySelector('[data-settings-row-text]')?.getBoundingClientRect().width ?? 0,
    row: el.getBoundingClientRect().width,
  }))
}

test('settings rows keep a readable text column beside or above a wide control', async () => {
  const dataHome = freshDataHome()
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, OSTIA_TELEMETRY_URL: 'http://phc_e2e@127.0.0.1:9' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    for (const width of WINDOW_WIDTHS) {
      await app.evaluate(({ BrowserWindow }, w) => {
        BrowserWindow.getAllWindows()[0]?.setSize(w, 800)
      }, width)
      await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width)
      for (const { section, label } of ROWS) {
        const { text, row } = await measure(win, section, label)
        console.log(
          `ROW width=${width} ${label}: text ${Math.round(text)}px of ${Math.round(row)}px`,
        )
        expect.soft(row, `${label} row inside the window`).toBeLessThanOrEqual(width)
        expect
          .soft(text, `${label} at a ${width}px window`)
          .toBeGreaterThanOrEqual(Math.min(MIN_TEXT_WIDTH, row) - 0.5)
      }
    }
  } finally {
    await app.close()
  }
})
