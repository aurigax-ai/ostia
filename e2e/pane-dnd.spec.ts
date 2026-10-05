import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

interface PaneBox {
  x: number
  y: number
  tabs: string[]
}

async function launchApp(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function panes(win: Page): Promise<PaneBox[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.pane')]
      .filter((p) => p.offsetParent !== null)
      .map((p) => {
        const r = p.getBoundingClientRect()
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          tabs: [...p.querySelectorAll('.pane-tab')].map(
            (t) => t.getAttribute('data-tab-id') ?? '',
          ),
        }
      }),
  )
}

async function twoTabs(win: Page): Promise<string[]> {
  await openWorkspace(win)
  await win.getByRole('button', { name: 'New terminal tab' }).first().click()
  await expect(win.locator('.pane-tab:visible')).toHaveCount(2)
  await expect(win.locator('.xterm-rows:visible')).toContainText(/[❯$%#]/, { timeout: 15_000 })
  return (await panes(win))[0].tabs
}

async function expectTerminalsUsable(win: Page): Promise<void> {
  await expect(win.locator('.pane-drop-layer')).toHaveCount(0)
  const term = win.locator('.xterm:visible').first()
  await term.click()
  await win.keyboard.type('echo still-typing')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows:visible').first()).toContainText('still-typing')
}

async function dragTabToEdge(win: Page, tabId: string, edge: 'right' | 'bottom'): Promise<void> {
  const pane = win.locator(`.pane:visible:has(.pane-tab[data-tab-id="${tabId}"])`)
  const box = await pane.boundingBox()
  if (!box) throw new Error('no pane')
  const targetPosition =
    edge === 'right'
      ? { x: box.width - 16, y: box.height / 2 }
      : { x: box.width / 2, y: box.height - 16 }
  await win.locator(`.pane-tab[data-tab-id="${tabId}"]`).dragTo(pane, { targetPosition })
}

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test('dragging a tab to a terminal pane’s right edge splits it with the tab on the right', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    const [first, second] = await twoTabs(win)

    await dragTabToEdge(win, second, 'right')

    await expect
      .poll(() => panes(win))
      .toEqual([
        expect.objectContaining({ tabs: [first] }),
        expect.objectContaining({ tabs: [second] }),
      ])
    const [left, right] = await panes(win)
    expect(right.x).toBeGreaterThan(left.x)
    expect(right.y).toBe(left.y)
    await expectTerminalsUsable(win)
  } finally {
    await app.close()
  }
})

test('dragging a tab to a terminal pane’s bottom edge splits it with the tab below', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    const [first, second] = await twoTabs(win)

    await dragTabToEdge(win, second, 'bottom')

    await expect
      .poll(() => panes(win).then((p) => p.map((x) => x.tabs)))
      .toEqual([[first], [second]])
    const [top, bottom] = await panes(win)
    expect(bottom.y).toBeGreaterThan(top.y)
    expect(bottom.x).toBe(top.x)
    await expectTerminalsUsable(win)
  } finally {
    await app.close()
  }
})

test('tabs reorder within their tab bar', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    const [first, second] = await twoTabs(win)

    await win
      .locator(`.pane-tab[data-tab-id="${second}"]`)
      .dragTo(win.locator(`.pane-tab[data-tab-id="${first}"]`), {
        targetPosition: { x: 6, y: 10 },
      })

    await expect.poll(() => panes(win).then((p) => p.map((x) => x.tabs))).toEqual([[second, first]])
    await expectTerminalsUsable(win)
  } finally {
    await app.close()
  }
})

test('an editor tab dropped on a terminal’s tab bar joins that stack', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    writeFileSync(join(dataHome, 'home', 'notes.md'), '# notes\n')
    await openWorkspace(win)
    const [terminal] = (await panes(win))[0].tabs
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'notes.md' }).click()
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    const editor = (await panes(win))[0].tabs.find((id) => id !== terminal) ?? ''

    await dragTabToEdge(win, editor, 'right')
    await expect
      .poll(() => panes(win).then((p) => p.map((x) => x.tabs)))
      .toEqual([[terminal], [editor]])

    await win
      .locator(`.pane-tab[data-tab-id="${editor}"]`)
      .dragTo(win.locator(`.pane-tab[data-tab-id="${terminal}"]`), {
        targetPosition: { x: 6, y: 10 },
      })

    await expect
      .poll(() => panes(win).then((p) => p.map((x) => x.tabs)))
      .toEqual([[editor, terminal]])
  } finally {
    await app.close()
  }
})

test('a drag over a browser pane lands on the drop layer above the page and splits it', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    await openWorkspace(win)
    const [terminal] = (await panes(win))[0].tabs
    await win.getByRole('button', { name: 'New browser tab' }).first().click()
    await expect(win.locator('webview')).toHaveCount(1, { timeout: 15_000 })
    const browser = (await panes(win))[0].tabs.find((id) => id !== terminal) ?? ''
    const page = await win.locator('webview').boundingBox()
    if (!page) throw new Error('no webview')
    const point = { clientX: page.x + page.width / 2, clientY: page.y + page.height - 12 }

    const hit = await win.evaluate(
      ({ terminal, point }) => {
        const dataTransfer = new DataTransfer()
        dataTransfer.setData('application/x-ostia-pane', terminal)
        const tab = document.querySelector(`.pane-tab[data-tab-id="${terminal}"]`)
        tab?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
        return new Promise<string>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const under = document.elementFromPoint(point.clientX, point.clientY)
              for (const type of ['dragover', 'drop']) {
                under?.dispatchEvent(
                  new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...point }),
                )
              }
              tab?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
              resolve(under?.className ?? '')
            }),
          ),
        )
      },
      { terminal, point },
    )

    expect(hit).toBe('pane-drop-layer')
    await expect
      .poll(() => panes(win).then((p) => p.map((x) => x.tabs)))
      .toEqual([[browser], [terminal]])
  } finally {
    await app.close()
  }
})
