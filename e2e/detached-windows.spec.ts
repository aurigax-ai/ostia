import { isMac } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launchApp(dataHome: string): Promise<Launched> {
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

async function closeWindow(page: Page): Promise<void> {
  if (isMac) await page.evaluate(() => window.ostia.window.close())
  else await page.locator('.win-controls').getByRole('button', { name: 'Close' }).click()
}

async function typeInTerminal(win: Page, text: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}

async function lastTick(scope: Page | Locator, marker: string): Promise<number> {
  const text = await scope.locator('.xterm-rows').first().innerText()
  const ticks = [...text.matchAll(new RegExp(`${marker}-(\\d+)`, 'g'))].map((m) => Number(m[1]))
  return ticks.length > 0 ? Math.max(...ticks) : 0
}

async function detachFirstWorkspace(app: ElectronApplication, win: Page): Promise<Page> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  const [detached] = await Promise.all([
    app.waitForEvent('window'),
    win.getByRole('menuitem', { name: 'Move to new window' }).click(),
  ])
  await detached.waitForLoadState('domcontentloaded')
  return detached
}

async function windowTitles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))
}

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test('a detached workspace keeps its running command and comes back when its window closes', async () => {
  test.setTimeout(90_000)
  const marker = `tick${Date.now() % 100000}`
  const { app, win } = await launchApp(dataHome)
  try {
    await openWorkspace(win)
    const project = (await win.locator('.rail-row .tab-title').first().innerText()).trim()
    await typeInTerminal(win, `for i in $(seq 1 1000); do echo ${marker}-$i; sleep 0.2; done`)
    await expect(win.locator('.xterm-rows').first()).toContainText(`${marker}-3`, {
      timeout: 15_000,
    })

    const detached = await detachFirstWorkspace(app, win)
    await expect(detached.locator('.detached-title')).toHaveText(project)
    await expect(detached.locator('.deck-rail')).toHaveCount(0)
    await expect.poll(() => windowTitles(app)).toContainEqual(expect.stringContaining(project))

    await expect.poll(() => lastTick(detached, marker), { timeout: 15_000 }).toBeGreaterThan(3)
    const atDetach = await lastTick(detached, marker)
    await expect
      .poll(() => lastTick(detached, marker), { timeout: 15_000 })
      .toBeGreaterThan(atDetach + 5)
    await expect(detached.locator('.xterm-rows').first()).not.toContainText('workspace restored')

    await expect(win.locator('.workzone-empty')).toBeVisible()
    const remote = win.locator('.rail-row.remote')
    await expect(remote).toHaveCount(1)
    await expect(remote).toContainText(project)

    const closed = detached.waitForEvent('close')
    await closeWindow(detached)
    await closed

    await expect(win.locator('.rail-row.remote')).toHaveCount(0)
    await expect(win.locator('.rail-row')).toHaveCount(1)
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
    const atReturn = await lastTick(win, marker)
    await expect
      .poll(() => lastTick(win, marker), { timeout: 15_000 })
      .toBeGreaterThan(Math.max(atReturn, atDetach + 5) + 5)
    expect(app.windows()).toHaveLength(1)
  } finally {
    await quitApp(app)
  }
})

test('a detached window reopens where it was after a restart, idle', async () => {
  test.setTimeout(90_000)
  const marker = `ostia_detached_${Date.now()}`
  const first = await launchApp(dataHome)
  let project = ''
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  try {
    const area = await first.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    bounds = {
      x: area.x + 40,
      y: area.y + 40,
      width: Math.min(820, area.width - 80),
      height: Math.min(520, area.height - 80),
    }
    await openWorkspace(first.win)
    project = (await first.win.locator('.rail-row .tab-title').first().innerText()).trim()
    await typeInTerminal(first.win, `echo ${marker}`)
    await expect(first.win.locator('.xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })
    const detached = await detachFirstWorkspace(first.app, first.win)
    await expect(detached.locator('.xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })
    await expect.poll(() => windowTitles(first.app)).toContainEqual(expect.stringMatching(project))
    await first.app.evaluate(
      ({ BrowserWindow }, { b, name }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle().startsWith(name))
          ?.setBounds(b)
      },
      { b: bounds, name: project },
    )
    await detached.waitForTimeout(1_000)
  } finally {
    await quitApp(first.app)
  }

  const second = await launchApp(dataHome)
  try {
    await expect.poll(() => second.app.windows().length, { timeout: 15_000 }).toBe(2)
    const pages = second.app.windows()
    for (const page of pages) await page.waitForLoadState('domcontentloaded')
    await expect
      .poll(async () => {
        const detached = await Promise.all(pages.map((p) => p.locator('.app.is-detached').count()))
        return detached.sort()
      })
      .toEqual([0, 1])
    const flags = await Promise.all(pages.map((p) => p.locator('.app.is-detached').count()))
    const reopened = pages[flags.indexOf(1)]
    const main = pages[flags.indexOf(0)]
    await expect(reopened.locator('.detached-title')).toHaveText(project, { timeout: 15_000 })
    await expect(reopened.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
    await expect(reopened.locator('.workzone')).toContainText('workspace restored')
    await expect(main.locator('.rail-row.remote')).toContainText(project)
    const restored = await second.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.getBounds()),
    )
    expect(restored).toContainEqual(bounds)
  } finally {
    await quitApp(second.app)
  }
})
