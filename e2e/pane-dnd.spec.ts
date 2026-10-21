import { freshDataHome } from './dataHome'
import { launchWindow, openWorkspace } from './helpers'
import { type Page, expect, test } from './test'

interface PaneBox {
  x: number
  y: number
  tabs: string[]
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

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test('a drag over a browser pane lands on the drop layer above the page and splits it', async () => {
  const { app, win } = await launchWindow(dataHome)
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
