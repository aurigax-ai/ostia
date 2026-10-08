import { textPainted } from './pixels'
import { type ElectronApplication, type Locator, type Page, expect } from './test'

export const PROMPT = /[❯$%#]/

export function emptyState(win: Page): Locator {
  return win.locator('.workzone-empty')
}

export function emptyWorkspace(win: Page): Locator {
  return win.locator('.workspace-empty:visible')
}

export async function newTerminal(win: Page): Promise<void> {
  await emptyState(win)
    .getByRole('button', { name: /New workspace/ })
    .click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
}

const TERMINALS = '.xterm, .ghostty-host'

async function promptShown(win: Page): Promise<boolean> {
  const rows = win.locator('.xterm-rows').first()
  if ((await rows.count()) > 0) return PROMPT.test((await rows.textContent()) ?? '')
  const painted = win.locator('.xterm-screen, .ghostty-host').first()
  if ((await painted.count()) === 0) return false
  return textPainted(await painted.screenshot(), win)
}

export async function openWorkspace(win: Page): Promise<void> {
  const before = await win.locator(TERMINALS).count()
  await newTerminal(win)
  await expect(win.locator(TERMINALS)).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(win.locator(TERMINALS).first()).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => promptShown(win), { timeout: 15_000 }).toBe(true)
}

export async function newTerminalWorkspace(win: Page): Promise<void> {
  const before = await win.locator('.xterm').count()
  await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.xterm')).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows').last()).toContainText(
    PROMPT,
    { timeout: 15_000 },
  )
}

export async function typeLine(win: Page, line: string): Promise<void> {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

function shownBlockIds(win: Page): Promise<(string | null)[]> {
  return win
    .locator('.pane-slot:not([data-hidden]) .block-gutter')
    .evaluateAll((gutters) => gutters.map((gutter) => gutter.getAttribute('data-block-id')))
}

export async function typeLineToEnd(win: Page, line: string): Promise<void> {
  const before = await shownBlockIds(win)
  await typeLine(win, line)
  await expect
    .poll(async () => (await shownBlockIds(win)).some((id) => !before.includes(id)), {
      timeout: 15_000,
    })
    .toBe(true)
}

export function shownTerminal(win: Page): Locator {
  return win.locator('.pane-slot:not([data-hidden]) .xterm:visible').first()
}

export async function runInTerminal(
  win: Page,
  line: string,
  terminal: Locator = win.locator('.xterm').first(),
): Promise<void> {
  await terminal.click()
  await typeLine(win, line)
}

export async function addTab(win: Page): Promise<void> {
  const strip = win.getByRole('tablist')
  const box = await strip.boundingBox()
  const lastTab = await strip.locator('.pane-tab').last().boundingBox()
  if (!lastTab || !box) throw new Error('tab strip is not laid out')
  await win.mouse.dblclick(lastTab.x + lastTab.width + 40, box.y + box.height / 2)
}

export async function stubExternalOpener(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.assign(globalThis, { __openedExternally: opened })
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
}

export function openedExternally(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __openedExternally: string[] }).__openedExternally,
  )
}

export function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
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

export async function askToQuit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
}

export async function quitApp(app: ElectronApplication): Promise<void> {
  await askToQuit(app)
  await app.close().catch(() => {})
}

export async function restartApp(app: ElectronApplication, win: Page): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => undefined
  })
  const closed = app.waitForEvent('close')
  await win.evaluate(() => {
    void window.ostia.update.restart()
  })
  await closed
}

export function guestText(app: ElectronApplication, origin: string): Promise<string> {
  return app.evaluate(async ({ webContents }, prefix) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(prefix))
    return guest ? String(await guest.executeJavaScript('document.body.innerText')) : ''
  }, origin)
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
    await askToQuit(app)
  } else {
    await win.evaluate(() => window.ostia.window.quit()).catch(() => {})
  }
  return Promise.race([exited, dialogShown(win).then((shown) => shown ?? exited)])
}

export async function hoverInEditor(
  win: Page,
  target: Locator,
  position?: { x: number; y: number },
): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('hover target has no box')
  const at = position ?? { x: box.width / 2, y: box.height / 2 }
  await target.hover({ force: true, position: at })
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  await target.hover({ force: true, position: { x: Math.min(at.x + 1, box.width - 1), y: at.y } })
}
