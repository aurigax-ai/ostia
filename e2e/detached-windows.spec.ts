import {
  type ElectronApplication,
  type Locator,
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

async function movePaneOut(app: ElectronApplication, win: Page, index: number): Promise<Page> {
  await win.locator('.pane-tab:visible').nth(index).click({ button: 'right' })
  const [detached] = await Promise.all([
    app.waitForEvent('window'),
    win.getByRole('menuitem', { name: 'Move pane to new window' }).click(),
  ])
  await detached.waitForLoadState('domcontentloaded')
  return detached
}

async function splitWithTicker(win: Page, marker: string): Promise<void> {
  await openWorkspace(win)
  await win.getByRole('button', { name: 'Split right' }).first().click()
  await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
  await expect(win.locator('.xterm-rows').nth(1)).toContainText(/[❯$%#]/, { timeout: 15_000 })
  await win.locator('.xterm').nth(1).click()
  await win.keyboard.type(`for i in $(seq 1 1000); do echo ${marker}-$i; sleep 0.2; done`)
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').nth(1)).toContainText(`${marker}-3`, { timeout: 15_000 })
}

async function visiblePanes(win: Page): Promise<{ x: number; tabs: string[] }[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.pane')]
      .filter((p) => p.offsetParent !== null)
      .map((p) => ({
        x: Math.round(p.getBoundingClientRect().x),
        tabs: [...p.querySelectorAll('.pane-tab')].map((t) => t.getAttribute('data-tab-id') ?? ''),
      }))
      .sort((a, b) => a.x - b.x),
  )
}

async function dispatchDrag(
  page: Page,
  selector: string,
  type: string,
  init: { paneId: string; clientX?: number; clientY?: number; screenX?: number; screenY?: number },
): Promise<void> {
  await page.evaluate(
    ({ selector, type, init }) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-ostia-pane', init.paneId)
      const target = document.querySelector(selector)
      target?.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...init }),
      )
    },
    { selector, type, init },
  )
}

async function windowTitles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))
}

async function visibleWindows(app: ElectronApplication): Promise<boolean[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.isVisible()),
  )
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
  const marker = `ostia_detached_${Date.now()}`
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

    await typeInTerminal(detached, 'ostia settings set sidebar.showSSH false && echo APPROVED-RUN')

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

test('a pane moved to a new window rejoins its workspace when it comes back', async () => {
  test.setTimeout(90_000)
  const marker = `rejoin${Date.now() % 100000}`
  const { app, win } = await launchApp(dataHome)
  try {
    await splitWithTicker(win, marker)
    const before = await visiblePanes(win)
    const moved = before[1].tabs[0]

    const detached = await movePaneOut(app, win, 1)
    await expect(detached.locator('.xterm-rows').first()).toContainText(marker, { timeout: 15_000 })
    await expect(win.locator('.rail-row.remote')).toHaveCount(1)

    await detached.getByRole('button', { name: 'Move back to main window' }).click()

    await expect(win.locator('.rail-row')).toHaveCount(1)
    await expect(win.locator('.rail-row.remote')).toHaveCount(0)
    await expect
      .poll(() => visiblePanes(win))
      .toEqual([
        { x: before[0].x, tabs: before[0].tabs },
        expect.objectContaining({ tabs: [moved] }),
      ])
    const at = await lastTick(win.locator('.pane:visible').nth(1), marker)
    await expect
      .poll(() => lastTick(win.locator('.pane:visible').nth(1), marker), { timeout: 15_000 })
      .toBeGreaterThan(at + 3)
    expect(app.windows()).toHaveLength(1)
  } finally {
    await quitApp(app)
  }
})

test('dragging a tab out of the window opens it in a new window with its command still running', async () => {
  test.setTimeout(90_000)
  const marker = `dragout${Date.now() % 100000}`
  const { app, win } = await launchApp(dataHome)
  try {
    await splitWithTicker(win, marker)
    const moved = (await visiblePanes(win))[1].tabs[0]
    const origin = await win.evaluate(() => ({ x: window.screenX, y: window.screenY }))
    const tab = `.pane-tab[data-tab-id="${moved}"]`

    await dispatchDrag(win, tab, 'dragstart', {
      paneId: moved,
      clientX: 600,
      clientY: 50,
      screenX: origin.x + 600,
      screenY: origin.y + 50,
    })
    await dispatchDrag(win, tab, 'dragend', {
      paneId: moved,
      clientX: 600,
      clientY: 50,
      screenX: origin.x + 600,
      screenY: origin.y + 300,
    })
    await win.waitForTimeout(800)
    expect(app.windows()).toHaveLength(1)

    await dispatchDrag(win, tab, 'dragstart', {
      paneId: moved,
      clientX: 600,
      clientY: 50,
      screenX: origin.x + 600,
      screenY: origin.y + 50,
    })
    const [detached] = await Promise.all([
      app.waitForEvent('window'),
      dispatchDrag(win, tab, 'dragend', {
        paneId: moved,
        screenX: origin.x + 1600,
        screenY: origin.y + 120,
      }),
    ])
    await detached.waitForLoadState('domcontentloaded')

    await expect(detached.locator(`.pane-tab[data-tab-id="${moved}"]`)).toHaveCount(1)
    const at = await lastTick(detached.locator('.pane:visible').first(), marker)
    await expect
      .poll(() => lastTick(detached.locator('.pane:visible').first(), marker), { timeout: 15_000 })
      .toBeGreaterThan(at + 3)
    await expect(win.locator(`.pane-tab[data-tab-id="${moved}"]`)).toHaveCount(0)
    await expect(win.locator('.rail-row')).toHaveCount(2)
  } finally {
    await quitApp(app)
  }
})

test('dropping a detached pane onto the main window moves it there and closes the empty window', async () => {
  test.setTimeout(90_000)
  const marker = `dropin${Date.now() % 100000}`
  const { app, win } = await launchApp(dataHome)
  try {
    await splitWithTicker(win, marker)
    const [left, right] = await visiblePanes(win)
    const moved = right.tabs[0]
    const detached = await movePaneOut(app, win, 1)
    await expect(detached.locator('.xterm-rows').first()).toContainText(marker, { timeout: 15_000 })
    await expect.poll(() => visiblePanes(win)).toHaveLength(1)

    const highlighted = await win.evaluate((paneId) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-ostia-pane', paneId)
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }))
      return frame()
        .then(frame)
        .then(() => {
          const layer = document.querySelector('.pane-drop-layer')
          if (!layer) return false
          const r = layer.getBoundingClientRect()
          const at = { clientX: r.right - 10, clientY: r.top + r.height / 2 }
          layer.dispatchEvent(
            new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...at }),
          )
          return frame().then(() => {
            const shown = document.querySelector('.pane-drop-right') !== null
            layer.dispatchEvent(
              new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...at }),
            )
            return shown
          })
        })
    }, moved)
    expect(highlighted).toBe(true)
    const closed = detached.waitForEvent('close')
    await dispatchDrag(detached, `.pane-tab[data-tab-id="${moved}"]`, 'dragend', {
      paneId: moved,
      screenX: 300,
      screenY: 300,
    })
    await closed

    await expect(win.locator('.rail-row')).toHaveCount(1)
    await expect
      .poll(() => visiblePanes(win).then((p) => p.map((x) => x.tabs)))
      .toEqual([left.tabs, [moved]])
    const joined = win.locator(`.pane:visible:has(.pane-tab[data-tab-id="${moved}"])`)
    const at = await lastTick(joined, marker)
    await expect.poll(() => lastTick(joined, marker), { timeout: 15_000 }).toBeGreaterThan(at + 3)
  } finally {
    await quitApp(app)
  }
})

test('closing a detached window while the main window is in the tray keeps it there', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchApp(dataHome)
  try {
    await openWorkspace(win)
    await win.getByRole('button', { name: 'Split right' }).first().click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    const detached = await movePaneOut(app, win, 1)
    await expect(detached.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
    await win.evaluate(() => window.ostia.window.close())
    await expect.poll(() => visibleWindows(app).then((v) => v.sort())).toEqual([false, true])

    const closed = detached.waitForEvent('close')
    await detached.locator('.win-controls').getByRole('button', { name: 'Close' }).click()
    await closed

    await expect.poll(() => visibleWindows(app)).toEqual([false])
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show()
    })
    await expect.poll(() => visiblePanes(win).then((p) => p.length)).toBe(2)
    await expect(win.locator('.rail-row')).toHaveCount(1)
  } finally {
    await quitApp(app)
  }
})
