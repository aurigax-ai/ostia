import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { openWorkspace, shownTerminal, terminalTab } from './helpers'
import type { ElectronApplication, Page } from './test'
import { _electron as electron, expect, test } from './test'
import { viewerGuestRun, viewerGuestText } from './viewerGuest'

const MATCH = { viewType: 'markdown.preview' }
const SOURCE = '# Report\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

async function guestClick(app: ElectronApplication, selector: string): Promise<void> {
  const point = (await viewerGuestRun(
    app,
    MATCH,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )) as { x: number; y: number } | null
  if (!point) throw new Error(`no ${selector} in the preview`)
  await app.evaluate(async ({ webContents }, { x, y }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().startsWith('ostia-viewer://')) continue
      const meta = await contents
        .executeJavaScript('fetch("/~meta").then((r) => r.json())')
        .catch(() => null)
      if (meta?.viewType !== 'markdown.preview') continue
      contents.sendInputEvent({ type: 'mouseMove', x, y })
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
  }, point)
}

async function openReadme(win: Page): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await win.locator('.file-row').filter({ hasText: 'README.md' }).click()
  await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.monaco-editor .view-lines').first()).toContainText('First paragraph', {
    timeout: 15_000,
  })
}

async function typeUnsaved(win: Page): Promise<void> {
  await win.locator('.monaco-editor .view-lines').first().click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('\nUnsaved third line')
  await expect(win.locator('.monaco-editor .view-lines').first()).toContainText(
    'Unsaved third line',
  )
}

test('the preview shows unsaved text, sends a selection with its source lines and returns to the source', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const home = isolatedHome(dataHome)
  writeFileSync(join(home, 'README.md'), SOURCE)
  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await startFakeAgent(win)
    await openReadme(win)
    await typeUnsaved(win)

    await win.getByRole('button', { name: 'Open with Preview' }).click()
    await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
      'data-view-type',
      'markdown.preview',
      { timeout: 20_000 },
    )
    await expect
      .poll(() => viewerGuestText(app, MATCH), { timeout: 20_000 })
      .toContain('Unsaved third line')
    expect(readFileSync(join(home, 'README.md'), 'utf8')).toBe(SOURCE)

    await viewerGuestRun(
      app,
      MATCH,
      `(() => {
        const text = [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Second')).firstChild
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 6)
        getSelection().removeAllRanges()
        getSelection().addRange(range)
        document.dispatchEvent(new Event('pointerup'))
      })()`,
    )
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Add a note' }).click()
    await bar.getByRole('textbox', { name: 'Add a note' }).fill('check this heading')
    await bar.getByRole('button', { name: 'Send to agent' }).click()
    await win.getByRole('menuitem').first().click()

    await terminalTab(win).click()
    const terminal = shownTerminal(win).locator('.xterm-rows')
    const pasted = /@(\S+\.md)/
    await expect(terminal).toContainText(pasted, { timeout: 15_000 })
    const reportPath = (((await terminal.textContent()) ?? '').match(pasted) as RegExpMatchArray)[1]
    const report = readFileSync(reportPath, 'utf8')
    expect(report).toContain('README.md')
    expect(report).toMatch(/Lines: 5\b/)
    expect(report).toContain('Second')
    expect(report).toContain('check this heading')
    expect(((await terminal.textContent()) ?? '').match(/@\S+\.md/g)).toHaveLength(1)

    await win.locator('.pane-tab').filter({ hasText: 'README.md' }).click()
    await viewerGuestRun(
      app,
      MATCH,
      `getSelection().removeAllRanges(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`,
    )
    await guestClick(app, 'main')
    await guestClick(app, 'button[aria-label="Edit source"]')
    await expect(win.locator('[data-testid="file-viewer"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(win.locator('.monaco-editor .view-lines').first()).toContainText(
      'Unsaved third line',
    )
  } finally {
    await app.close()
  }
})

test('the preview draws a diagram as an image, lists the headings and runs no raw HTML', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const home = isolatedHome(dataHome)
  writeFileSync(
    join(home, 'README.md'),
    '# Report\n\n## Plan\n\n```mermaid\ngraph TD\n  Start --> Done\n```\n\n<script>document.title = "ran"</script>\n',
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'README.md' }).click()
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    await win.getByRole('button', { name: 'Open with Preview' }).click()
    await expect
      .poll(
        () => viewerGuestRun(app, MATCH, 'document.querySelectorAll("img.mermaid-diagram").length'),
        { timeout: 40_000 },
      )
      .toBe(1)
    expect(
      await viewerGuestRun(
        app,
        MATCH,
        `(() => {
          const img = document.querySelector('img.mermaid-diagram')
          return [
            img.src.startsWith('blob:'),
            img.naturalWidth > 20,
            document.querySelectorAll('article svg, article script').length,
            document.title === 'ran',
          ]
        })()`,
      ),
    ).toEqual([true, true, 0, false])

    await guestClick(app, 'main')
    await guestClick(app, 'button[aria-label="Contents"]')
    await expect
      .poll(() =>
        viewerGuestRun(app, MATCH, 'document.querySelectorAll(".markdown-contents-item").length'),
      )
      .toBe(2)
  } finally {
    await app.close()
  }
})
