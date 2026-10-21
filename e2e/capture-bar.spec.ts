import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chords, defaultChord, isMac } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const SOURCE = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0)
}
`

const PAGE = `<!doctype html>
<html><head><title>Capture fixture</title></head>
<body style="margin:0">
  <p id="note" style="margin:16px">Refund pending for order 4823</p>
  <table id="orders" style="margin:16px;border-collapse:collapse">
    <thead><tr><th>Order</th><th colspan="2">Customer</th></tr></thead>
    <tbody>
      <tr><td data-testid="first-cell">#4821</td><td>Northwind, Ltd</td><td>EU</td></tr>
      <tr><td>#4822</td><td>Fabrikam "Home"</td><td>US</td></tr>
    </tbody>
  </table>
  <div id="swatch" style="margin:16px;width:120px;height:60px;background:#ff0000"></div>
</body></html>`

const sendToAgent = defaultChord('selection.sendToAgent', isMac)
const plainCopy = isMac ? 'Meta+c' : 'Control+c'

const readClipboard = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const plain = items.find((item) => item.types.includes('text/plain'))
    return {
      text: plain ? await (await plain.getType('text/plain')).text() : '',
      hasImage: items.some((item) => item.types.some((type) => type.startsWith('image/'))),
    }
  })

test('Monaco opens the capture bar only from the chord, and Copy puts the selection on the clipboard', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'total.ts'), SOURCE)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'total.ts' }).click()
    const editor = win.locator('.monaco-editor').first()
    await expect(editor).toBeVisible({ timeout: 15_000 })

    await expect(editor).toContainText('items.reduce', { timeout: 15_000 })
    const lines = await editor.locator('.view-lines').first().boundingBox()
    if (!lines) throw new Error('editor lines have no box')
    const y = lines.y + 27
    await win.mouse.move(lines.x + 8, y)
    await win.mouse.down()
    await win.mouse.move(lines.x + 240, y, { steps: 5 })
    await win.mouse.up()
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await win.waitForTimeout(600)
    await expect(bar).toHaveCount(0)

    const editorFocused = () =>
      win.evaluate(() => document.activeElement?.closest('.monaco-editor') != null)

    await win.keyboard.press(sendToAgent)
    await expect(bar).toBeVisible()
    await expect(bar).toBeFocused()
    await win.keyboard.press('Tab')
    await expect(bar.getByRole('button', { name: 'Copy' })).toBeFocused()
    await win.keyboard.press('Tab')
    await expect(bar.getByRole('button', { name: 'Send to agent' })).toBeFocused()
    await win.keyboard.press('Tab')
    await expect(bar.getByRole('button', { name: 'Add a note' })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(bar).toHaveCount(0)
    await expect.poll(editorFocused).toBe(true)

    await win.keyboard.press(sendToAgent)
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the selection.')).toBeVisible()
    await expect(bar).toHaveCount(0)
    const copied = await readClipboard(app)
    expect(copied.text.length).toBeGreaterThan(4)
    expect(SOURCE).toContain(copied.text)
    expect(copied.hasImage).toBe(false)

    await app.evaluate(({ clipboard }) => clipboard.writeText('marker'))
    await expect.poll(editorFocused).toBe(true)
    await win.keyboard.press(sendToAgent)
    await expect(bar).toBeVisible()
    await win.keyboard.press(plainCopy)
    await expect(win.getByText('Copied the selection.')).toBeVisible()
    await expect(bar).toHaveCount(0)
    expect((await readClipboard(app)).text).toBe(copied.text)
  } finally {
    await app.close()
  }
})

test('a browser pane copies a table as CSV, an element without text as an image, and page text with the chord', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const pagePath = join(dataHome, 'capture.html')
  writeFileSync(pagePath, PAGE)
  const pageUrl = pathToFileURL(pagePath).href
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    await win.locator('[data-slot="command-input"]').fill('Open Browser')
    await waitForPaletteSelection(win, 'Open Browser')
    await win.keyboard.press('Enter')
    const address = win.getByRole('textbox', { name: 'Address' })
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(pageUrl)
    await address.press('Enter')

    const guestEval = <T>(js: string): Promise<T> =>
      app.evaluate(
        async ({ webContents }, { url, code }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          return guest ? await guest.executeJavaScript(code) : null
        },
        { url: pageUrl, code: js },
      ) as Promise<T>
    await expect
      .poll(() => guestEval<boolean>('!!document.getElementById("orders")'), { timeout: 15_000 })
      .toBe(true)

    const pointAt = async (selector: string): Promise<void> => {
      await win.getByRole('button', { name: 'Point at element' }).click()
      await expect
        .poll(() => guestEval<boolean>('!!document.querySelector("[data-ostia-pick]")'))
        .toBe(true)
      const at = await guestEval<{ x: number; y: number }>(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
      )
      await app.evaluate(
        ({ webContents }, { url, x, y }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          if (!guest) throw new Error('guest missing')
          guest.sendInputEvent({ type: 'mouseMove', x, y })
          guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        },
        { url: pageUrl, ...at },
      )
    }
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })

    await pointAt('[data-testid=first-cell]')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the table (3 rows × 3 columns) as CSV.')).toBeVisible()
    const table = await readClipboard(app)
    expect(table.text).toBe(
      'Order,Customer,Customer\n#4821,"Northwind, Ltd",EU\n#4822,"Fabrikam ""Home""",US',
    )
    expect(table.hasImage).toBe(false)

    await pointAt('#swatch')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await app.evaluate(({ clipboard }) => clipboard.writeText('marker'))
    await win.keyboard.press(plainCopy)
    await expect(win.getByText('Copied the element screenshot.')).toBeVisible()
    const swatch = await readClipboard(app)
    expect(swatch.hasImage).toBe(true)

    await guestEval<void>(
      'window.getSelection().selectAllChildren(document.getElementById("note"))',
    )
    await win.keyboard.press(sendToAgent)
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the selection.')).toBeVisible()
    expect((await readClipboard(app)).text).toBe('Refund pending for order 4823')
  } finally {
    await app.close()
  }
})
