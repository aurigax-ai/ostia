import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

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

async function quitApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
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

async function lastTick(win: Page, marker: string): Promise<number> {
  const text = await win.locator('.xterm-rows').first().innerText()
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
    await detached.locator('.win-controls').getByRole('button', { name: 'Close' }).click()
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
  const marker = `pine_detached_${Date.now()}`
  const bounds = { x: 220, y: 140, width: 900, height: 640 }
  const first = await launchApp(dataHome)
  let project = ''
  try {
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

test('an agent in a detached pane asks for approval in its own window', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchApp(dataHome)
  try {
    await openWorkspace(win)
    await win.locator('.pane-tab').first().click({ button: 'right' })
    const [detached] = await Promise.all([
      app.waitForEvent('window'),
      win.getByRole('menuitem', { name: 'Move pane to new window' }).click(),
    ])
    await detached.waitForLoadState('domcontentloaded')
    await expect(detached.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, {
      timeout: 15_000,
    })

    await typeInTerminal(detached, 'pine settings set sidebar.showSSH false && echo APPROVED-RUN')

    const card = detached.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(win.getByRole('region', { name: 'Agent permission request' })).toHaveCount(0)
    await card.getByRole('button', { name: 'Allow once' }).click()
    await expect(detached.locator('.xterm-rows')).toContainText('APPROVED-RUN', {
      timeout: 15_000,
    })
  } finally {
    await quitApp(app)
  }
})
