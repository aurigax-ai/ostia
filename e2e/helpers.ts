import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { escapeRegExp } from 'es-toolkit'
import { isolatedLaunch } from './dataHome'
import { textPainted } from './pixels'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  stopTrace,
  waitForExit,
} from './test'

export const PROMPT = /[❯$%#]/

const MARKETPLACE = resolve(__dirname, '../out/marketplace/extensions')

export function installApproved(dataHome: string, configHome: string, id: string): void {
  const target = join(configHome, PRODUCT_NAME, 'extensions', id)
  cpSync(join(MARKETPLACE, id), target, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(target, 'ostia.json'), 'utf8'))
  mkdirSync(join(dataHome, 'userData'), { recursive: true })
  writeFileSync(
    join(dataHome, 'userData', 'extensions.json'),
    JSON.stringify({ [id]: { enabled: true, approved: manifest.capabilities ?? [] } }),
  )
}

export function panelEval(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guests = webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    for (const guest of guests) {
      const shown = await guest.hostWebContents?.executeJavaScript(
        `[...document.querySelectorAll('webview')].some((w) => w.getWebContentsId() === ${guest.id} && !w.closest('[data-hidden]'))`,
      )
      if (shown) return String(await guest.executeJavaScript(code))
    }
    return ''
  }, script)
}

export function readPaneEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

export async function waitForTerminalFocus(win: Page): Promise<void> {
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
}

export async function launchWindow(
  dataHome: string,
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

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

export async function expectHeld<T>(
  read: () => Promise<T>,
  expected: T,
  holdMs = 2_000,
  message?: string,
): Promise<void> {
  const until = Date.now() + holdMs
  do {
    const actual: unknown = await read()
    expect(actual, message).toEqual(expected)
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < until)
}

export async function closeAllWorkspaces(win: Page): Promise<void> {
  const tabs = win.locator('.rail-tab')
  for (let open = await tabs.count(); open > 0; open--) {
    await tabs.first().hover()
    await tabs.first().getByRole('button', { name: 'Close' }).click()
    await expect(tabs).toHaveCount(open - 1)
  }
}

const ACCENTS = ['#ff8800', '#0088ff']

const brandColour = (win: Page): Promise<string> =>
  win.evaluate(() => document.documentElement.style.getPropertyValue('--color-brand'))

export async function changeSettings(
  win: Page,
  patch: Record<string, Record<string, unknown>>,
): Promise<void> {
  const before = await brandColour(win)
  await win.evaluate(
    async ({ patch, accents }) => {
      const path = await window.ostia.settings.path()
      const res = await window.ostia.fs.read(path)
      const current = JSON.parse(res.ok ? res.text : '{}')
      for (const [section, values] of Object.entries(patch)) {
        current[section] = { ...current[section], ...values }
      }
      const accent = current.appearance?.accent
      current.appearance = {
        ...current.appearance,
        accent: accent === accents[0] ? accents[1] : accents[0],
      }
      await window.ostia.fs.write(path, JSON.stringify(current, null, 2))
    },
    { patch, accents: ACCENTS },
  )
  await expect.poll(() => brandColour(win)).not.toBe(before)
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

export function terminalTab(win: Page): Locator {
  return win.locator('.pane-tab').first().getByRole('tab')
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

export async function showInbox(win: Page): Promise<Locator> {
  await win.locator('[data-slot="command-input"]').fill('Activity: Open')
  await waitForPaletteSelection(win, 'Activity: Open')
  await win.keyboard.press('Enter')
  const panel = win.locator('#right-panel')
  await panel.getByRole('tab', { name: /^Inbox/ }).click()
  return panel
}

export async function waitForPaletteSelection(win: Page, title: string): Promise<void> {
  const option = win.getByRole('option', { name: new RegExp(`^${escapeRegExp(title)}`) }).first()
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
}

export async function askToQuit(app: ElectronApplication): Promise<void> {
  await stopTrace(app)
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
  await stopTrace(app)
  const exited = waitForExit(app)
  await win.evaluate(() => {
    void window.ostia.update.restart()
  })
  await exited
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
  await stopTrace(app)
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
