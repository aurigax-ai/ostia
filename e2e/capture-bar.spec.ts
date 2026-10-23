import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chords, defaultChord, isMac } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { guestKeys, pressInPage } from './guestKeys'
import { launchWindow, openWorkspace, runInTerminal, waitForPaletteSelection } from './helpers'
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
    await pressInPage(app, guestKeys.sendToAgent)
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the selection.')).toBeVisible()
    expect((await readClipboard(app)).text).toBe('Refund pending for order 4823')
  } finally {
    await app.close()
  }
})

const PREVIEW_PAGE = `<!doctype html><title>preview</title>
<body style="margin:0">
  <p id="note" style="margin:40px;font:24px sans-serif">Selectable preview words</p>
  <table id="orders" style="margin:0 40px;border-collapse:collapse;font:18px sans-serif">
    <thead><tr><th>Order</th><th>Customer</th></tr></thead>
    <tbody><tr><td id="cell">#4821</td><td>Northwind</td></tr><tr><td>#4822</td><td>Fabrikam</td></tr></tbody>
  </table>
</body>`

test('a running HTML preview points at an element, sends selected text and crops, through the browser capture bar', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'page.html'), PREVIEW_PAGE)
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, editor: { openFilesIn: 'split' } })
  const { app, win } = await launchWindow(dataHome)
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'ostia open ~/page.html')
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    await win.getByRole('button', { name: 'Run page in preview' }).click()
    const frame = win.locator('.preview-frame')
    await expect(frame).toBeVisible({ timeout: 20_000 })

    const inPreview = <T>(code: string): Promise<T | null> =>
      app.evaluate(async ({ webContents }, js) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getURL().startsWith('ostia-preview://'))
        return guest ? await guest.executeJavaScript(js) : null
      }, code) as Promise<T | null>
    await expect
      .poll(() => inPreview<string>('document.body.innerText'), { timeout: 20_000 })
      .toContain('Selectable preview words')
    expect(
      await app.evaluate(({ webContents }) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getURL().startsWith('ostia-preview://'))
        return guest ? guest.mainFrame.frames.length : -1
      }),
    ).toBe(0)
    expect(await inPreview<string>('window.origin')).toBe('null')
    expect(
      await inPreview<string>(
        '(() => { try { localStorage.setItem("k", "v"); return "open" } catch (e) { return e.name } })()',
      ),
    ).toBe('SecurityError')

    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    const pointAt = async (selector: string): Promise<void> => {
      await win.getByRole('button', { name: 'Point at element' }).click()
      await expect
        .poll(() => inPreview<boolean>('!!document.querySelector("[data-ostia-pick]")'))
        .toBe(true)
      const at = await inPreview<{ x: number; y: number }>(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
      )
      if (!at) throw new Error('no point')
      await app.evaluate(({ webContents }, { x, y }) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getURL().startsWith('ostia-preview://'))
        if (!guest) throw new Error('no preview guest')
        guest.sendInputEvent({ type: 'mouseMove', x, y })
        guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      }, at)
    }

    await pointAt('#cell')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the table (3 rows × 2 columns) as CSV.')).toBeVisible()
    expect((await readClipboard(app)).text).toBe('Order,Customer\n#4821,Northwind\n#4822,Fabrikam')

    const area = await frame.boundingBox()
    if (!area) throw new Error('preview frame has no box')
    await win.mouse.move(area.x + 42, area.y + 55)
    await win.mouse.down()
    await win.mouse.move(area.x + 300, area.y + 55, { steps: 8 })
    await win.mouse.up()
    await expect
      .poll(() => inPreview<string>('String(getSelection())'), { timeout: 10_000 })
      .toContain('Selectable')
    await pressInPage(app, guestKeys.sendToAgent)
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the selection.')).toBeVisible()
    expect((await readClipboard(app)).text).toContain('Selectable')

    await win.getByRole('button', { name: 'Capture region' }).click()
    const box = await frame.boundingBox()
    if (!box) throw new Error('preview frame has no box')
    await win.mouse.move(box.x + 40, box.y + 40)
    await win.mouse.down()
    await win.mouse.move(box.x + 260, box.y + 120, { steps: 6 })
    await win.mouse.up()
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.region-crop-box')).toBeVisible()
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the image to the clipboard.')).toBeVisible()
    expect((await readClipboard(app)).hasImage).toBe(true)
    await expect(win.locator('.region-crop-box')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a terminal selection opens the capture bar from the chord, and Copy puts it on the clipboard', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWindow(freshDataHome())
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'printf "\\n%.0s" 1 2 3 4 5 6 7 8 9; echo terminal-capture-4821')
    const output = win.locator('.xterm-rows > div').filter({ hasText: /^terminal-capture-4821$/ })
    await expect(output).toBeVisible({ timeout: 15_000 })
    const at = await output.boundingBox()
    if (!at) throw new Error('terminal output row has no box')
    await win.mouse.dblclick(at.x + 30, at.y + at.height / 2)
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await win.keyboard.press(sendToAgent)
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the selection.')).toBeVisible()
    await expect(bar).toHaveCount(0)
    expect((await readClipboard(app)).text).toContain('terminal-capture-4821')
  } finally {
    await app.close()
  }
})
