import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plainCopy, readClipboard, runCaptureMatrix } from './captureMatrix'
import { csvViewerSurface, monacoSurface, terminalSurface } from './captureSurfaces'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { guestKeys, pressInPage } from './guestKeys'
import { launchWindow, openWorkspace, runInTerminal, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

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

    const outline = win.locator('.browser-stage .region-crop-box')
    await pointAt('[data-testid=first-cell]')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect(outline).toBeVisible()
    await expect(outline.locator('.region-crop-size')).toHaveCount(0)
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the table (3 rows × 3 columns) as CSV.')).toBeVisible()
    const table = await readClipboard(app)
    expect(table.text).toBe(
      'Order,Customer,Customer\n#4821,"Northwind, Ltd",EU\n#4822,"Fabrikam ""Home""",US',
    )
    expect(table.hasImage).toBe(false)
    await expect(outline).toHaveCount(0)

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

    const outline = frame.locator('.region-crop-box')
    await pointAt('#cell')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect(outline).toBeVisible()
    await expect(outline.locator('.region-crop-size')).toHaveCount(0)
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByText('Copied the table (3 rows × 2 columns) as CSV.')).toBeVisible()
    expect((await readClipboard(app)).text).toBe('Order,Customer\n#4821,Northwind\n#4822,Fabrikam')
    await expect(outline).toHaveCount(0)

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

for (const surface of [terminalSurface, monacoSurface, csvViewerSurface]) {
  test(`${surface.name} follows the capture bar behaviour table`, async () => {
    test.setTimeout(180_000)
    await runCaptureMatrix(surface)
  })
}
