import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

type Rect = [number, number, number, number]

interface PaneWatch {
  frame: number
  painted: Rect[]
  done: boolean
  record: () => void
}

const FRAMES_AFTER_OPEN = 30

function watchNewPane(win: Page): Promise<void> {
  return win.evaluate((framesAfterOpen) => {
    const host = window as unknown as {
      paneWatch?: PaneWatch
      ResizeObserver: typeof ResizeObserver
    }
    const before = new Set(document.querySelectorAll('.pane'))
    const frames: (Rect | null)[] = []
    const watch: PaneWatch = {
      frame: -1,
      painted: [],
      done: false,
      record: () => {
        if (watch.frame < 0 || watch.done) return
        const pane = [...document.querySelectorAll('.pane')].reverse().find((p) => !before.has(p))
        const r = pane?.getBoundingClientRect()
        frames[watch.frame] = r ? [r.x, r.y, r.width, r.height] : null
      },
    }
    if (!host.paneWatch) {
      const Native = host.ResizeObserver
      host.ResizeObserver = class extends Native {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            callback(entries, observer)
            host.paneWatch?.record()
          })
        }
      }
    }
    host.paneWatch = watch
    const frame = (): void => {
      const settled = frames.filter((r) => r !== null).length >= framesAfterOpen
      if (settled) {
        watch.painted = frames.filter((r): r is Rect => r !== null)
        watch.done = true
        return
      }
      watch.frame += 1
      watch.record()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, FRAMES_AFTER_OPEN)
}

async function paintedOnlyAtFinalRect(win: Page): Promise<Rect> {
  await win.waitForFunction(
    () => (window as unknown as { paneWatch: PaneWatch }).paneWatch.done,
    null,
    { timeout: 15_000 },
  )
  const painted = await win.evaluate(
    () => (window as unknown as { paneWatch: PaneWatch }).paneWatch.painted,
  )
  const final = painted[painted.length - 1]
  const elsewhere = painted.filter((r) => r.some((v, i) => Math.abs(v - final[i]) > 1))
  expect(elsewhere, `painted before settling at ${JSON.stringify(final)}`).toEqual([])
  return final
}

function expectNear(actual: number, expected: number, tolerance = 1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

function makeRepo(home: string): void {
  const vcs = (...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: home })
  }
  vcs('init', '-q', '-b', 'main')
  writeFileSync(join(home, '.gitignore'), '*\n!.gitignore\n')
  vcs('add', '.gitignore')
  vcs('commit', '-q', '-m', 'root commit')
}

test('an extension panel opened from its toggle is painted only at its split position', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  makeRepo(launch.home)
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const toggle = win.locator('.topbar').getByRole('button', { name: 'Git', exact: true })
    const whole = await win.locator('.pane').first().boundingBox()
    if (!whole) throw new Error('no terminal pane')

    await watchNewPane(win)
    await toggle.click()
    const [left, top, width, height] = await paintedOnlyAtFinalRect(win)
    expectNear(left + width, whole.x + whole.width)
    expectNear(width, whole.width / 2, 2)
    expectNear(top, whole.y)
    expectNear(height, whole.height)

    await toggle.click()
    await expect(win.locator('.pane')).toHaveCount(1)
    await win.evaluate(() => localStorage.setItem('panelSizes', '{"extension:git":0.3}'))
    await watchNewPane(win)
    await toggle.click()
    const remembered = await paintedOnlyAtFinalRect(win)
    expectNear(remembered[0] + remembered[2], whole.x + whole.width)
    expectNear(remembered[2], whole.width * 0.3, 2)
  } finally {
    await app.close()
  }
})

const BOARD_VIEW = {
  version: 1,
  title: 'Board',
  placement: 'panel',
  root: { type: 'kv', items: [{ key: 'Current', value: '{{workspace.name}}' }] },
}

test('a view panel opened into a nested split is painted only at its split position', async () => {
  const dataHome = freshDataHome()
  const viewsDir = join(dataHome, 'config', 'ostia', 'views')
  mkdirSync(viewsDir, { recursive: true })
  writeFileSync(join(viewsDir, 'board.json'), JSON.stringify(BOARD_VIEW))
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Views', exact: true }).click()
    await settings
      .locator('[data-view-row="board"]')
      .getByRole('switch', { name: 'Show Board' })
      .click()
    await win.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    await win.getByRole('button', { name: 'Split down' }).first().click()
    await expect(win.locator('.xterm')).toHaveCount(2)
    const lower = await win.locator('.pane').nth(1).boundingBox()
    if (!lower) throw new Error('no lower pane')

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Views: Open Board')
    await waitForPaletteSelection(win, 'Views: Open Board')
    await watchNewPane(win)
    await win.keyboard.press('Enter')
    const [left, top, width, height] = await paintedOnlyAtFinalRect(win)
    await expect(win.locator('[data-view="board"]')).toBeVisible()
    expectNear(left + width, lower.x + lower.width)
    expectNear(width, lower.width / 2, 2)
    expectNear(top, lower.y)
    expectNear(height, lower.height)
  } finally {
    await app.close()
  }
})
