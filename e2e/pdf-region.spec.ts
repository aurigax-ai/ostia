import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { expectHeld, openWorkspace, shownTerminal, terminalTab } from './helpers'
import { textPdf } from './pdfFixture'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'
import { viewerGuestRun } from './viewerGuest'

const PDF = { viewType: 'pdf.pdf' }
const FIND_KEY = process.platform === 'darwin' ? 'meta' : 'control'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function launchWithPdf(): Promise<{ app: ElectronApplication; win: Page }> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'invoice.pdf'),
    textPdf('Hello needle one', 'Second page with a needle', 'Third page'),
  )
  const launch = isolatedLaunch(dataHome)
  const bin = fakeAgentBin(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
  const win = await app.firstWindow()
  await openWorkspace(win)
  await startFakeAgent(win)
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await win.locator('.file-row').filter({ hasText: 'invoice.pdf' }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    'pdf.pdf',
    { timeout: 15_000 },
  )
  await expect
    .poll(() => viewerGuestRun(app, PDF, 'document.querySelectorAll(".pdf-text span").length'), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  return { app, win }
}

async function guestBox(app: ElectronApplication, win: Page, selector: string): Promise<Box> {
  const inGuest = (await viewerGuestRun(
    app,
    PDF,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`,
  )) as Box
  const frame = await win.locator('webview:visible').boundingBox()
  if (!frame) throw new Error('the viewer has no box')
  return { ...inGuest, x: inGuest.x + frame.x, y: inGuest.y + frame.y }
}

async function readClipboard(app: ElectronApplication) {
  return app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const plain = items.find((item) => item.types.includes('text/plain'))
    return {
      text: plain ? await (await plain.getType('text/plain')).text() : '',
      hasImage: items.some((item) => item.types.some((type) => type.startsWith('image/'))),
    }
  })
}

async function dragOverTextLine(win: Page, app: ElectronApplication, fromEmpty: boolean) {
  const page = await guestBox(app, win, '.pdf-page')
  const span = await guestBox(app, win, '.pdf-text span')
  const y = span.y + span.height / 2
  const from = fromEmpty ? page.x + 6 : span.x + 2
  await win.mouse.move(from, y)
  await win.mouse.down()
  await win.mouse.move(span.x + span.width - 2, y + (fromEmpty ? 10 : 0), { steps: 6 })
  await win.mouse.up()
}

const bar = (win: Page) => win.getByRole('toolbar', { name: 'Selection actions' })

test('the PDF viewer selects text, crops text and image together, finds across pages and sends with a note', async () => {
  test.setTimeout(240_000)
  const { app, win } = await launchWithPdf()
  try {
    await test.step('a drag that starts on text selects text and Copy puts only text on the clipboard', async () => {
      await dragOverTextLine(win, app, false)
      await expect(bar(win)).toBeVisible({ timeout: 15_000 })
      await bar(win).getByRole('button', { name: 'Copy' }).click()
      await expect(bar(win)).toHaveCount(0)
      await expect.poll(async () => (await readClipboard(app)).text).toContain('Hello')
      expect((await readClipboard(app)).hasImage).toBe(false)
      await expect.poll(() => viewerGuestRun(app, PDF, 'getSelection().toString()')).toBe('')
    })

    await test.step('a drag that starts on empty page space crops a rectangle and Copy puts text and image on the clipboard', async () => {
      await dragOverTextLine(win, app, true)
      await expect(bar(win)).toBeVisible({ timeout: 15_000 })
      await expect(win.locator('webview:visible')).toBeVisible()
      await bar(win).getByRole('button', { name: 'Copy' }).click()
      await expect(bar(win)).toHaveCount(0)
      await expect
        .poll(async () => {
          const copied = await readClipboard(app)
          return copied.hasImage && copied.text.includes('Hello needle one')
        })
        .toBe(true)
    })

    await test.step('find opens with the find chord, counts matches over every page and steps through them', async () => {
      await app.evaluate(({ webContents }, modifier) => {
        const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
        if (!guest) throw new Error('no page')
        guest.focus()
        for (const type of ['keyDown', 'keyUp'] as const) {
          guest.sendInputEvent({ type, keyCode: 'F', modifiers: [modifier as 'control'] })
        }
      }, FIND_KEY)
      await expect
        .poll(() => viewerGuestRun(app, PDF, 'document.activeElement?.className ?? ""'))
        .toContain('ostia-pill-find-field')
      await viewerGuestRun(
        app,
        PDF,
        `(() => { const f = document.querySelector('.ostia-pill-find-field'); f.value = 'needle'; f.dispatchEvent(new Event('input')) })()`,
      )
      const count = () =>
        viewerGuestRun(
          app,
          PDF,
          `document.querySelector('.ostia-pill-find-count')?.textContent ?? ''`,
        )
      await expect.poll(count, { timeout: 20_000 }).toBe('1 of 2')
      await viewerGuestRun(
        app,
        PDF,
        `document.querySelector('.ostia-pill-find-field').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
      )
      await expect.poll(count).toBe('2 of 2')
      await expect
        .poll(() => viewerGuestRun(app, PDF, `document.querySelector('.ostia-pill-page').value`))
        .toBe('2')
    })

    await test.step('Send puts the report reference with the note at the agent prompt and presses no Enter', async () => {
      await viewerGuestRun(
        app,
        PDF,
        `document.querySelector('.ostia-pill-find button[aria-label="Done"]').click()`,
      )
      await viewerGuestRun(app, PDF, 'window.scrollTo(0, 0)')
      await expect
        .poll(() => viewerGuestRun(app, PDF, `document.querySelector('.ostia-pill-page').value`))
        .toBe('1')
      await dragOverTextLine(win, app, true)
      await expect(bar(win)).toBeVisible({ timeout: 15_000 })
      await bar(win).getByRole('button', { name: 'Add a note' }).click()
      await win.getByRole('textbox', { name: 'Add a note' }).fill('check the total')
      await bar(win).getByRole('button', { name: 'Send to agent' }).click()
      await win.getByRole('menuitem').first().click()
      await terminalTab(win).click()
      const terminal = shownTerminal(win).locator('.xterm-rows')
      await expect(terminal).toContainText(/@\S+\.md/, { timeout: 15_000 })
      const text = (await terminal.textContent()) ?? ''
      const report = /@(\S+\.md)/.exec(text)?.[1] ?? ''
      const body = readFileSync(report, 'utf8')
      expect(body).toContain('check the total')
      expect(body).toContain('Hello needle one')
      await expectHeld(
        async () => ((await terminal.textContent()) ?? '').match(/@\S+\.md/g)?.length ?? 0,
        1,
        800,
      )
    })
  } finally {
    await app.close()
  }
})
