import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, seedSettings } from './dataHome'
import { launchWindow, openWorkspace, quitApp, runInTerminal, terminalTab } from './helpers'
import { expect, type Page, test } from './test'
import { viewerGuestText } from './viewerGuest'

function run(win: Page, command: string): Promise<void> {
  return runInTerminal(win, command, win.locator('.xterm:visible').first())
}

async function printValue(win: Page, label: string, variable: string): Promise<string> {
  await run(win, `echo "${label}:""$${variable}"":END"`)
  const rows = win.locator('.xterm:visible .xterm-rows').first()
  const pattern = new RegExp(`${label}:(/[^"]*?):END`)
  await expect(rows).toContainText(pattern, { timeout: 15_000 })
  const match = pattern.exec((await rows.textContent()) ?? '')
  if (!match) throw new Error(`${label} was not printed`)
  return match[1]
}

function tab(win: Page, title: string) {
  return win.locator('.pane-tab').filter({ hasText: title })
}

function artifactRow(win: Page, name: string) {
  return win.getByTestId('artifact-row').filter({ hasText: name })
}

async function showFiles(win: Page): Promise<void> {
  if (await win.getByTestId('artifacts-section').isVisible()) return
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await expect(win.getByTestId('artifacts-section')).toBeVisible()
}

test('a shell writes artifacts that are listed and kept across a restart, and the pad is shared', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  let folder = ''
  let first = await launchWindow(dataHome)
  try {
    const { win } = first
    await openWorkspace(win)
    await showFiles(win)
    await expect(win.getByTestId('artifact-pad')).toHaveText('Scratch Pad')
    await expect(win.getByTestId('artifact-row')).toHaveCount(0)

    folder = await printValue(win, 'ART', 'OSTIA_ARTIFACTS')
    await run(win, 'printf "# Report\\n\\nfirst line\\n" > "$OSTIA_ARTIFACTS/report.md"')
    await expect(artifactRow(win, 'report.md')).toBeVisible({ timeout: 15_000 })

    await win.keyboard.press('Control+Alt+n')
    await expect(tab(win, 'PAD.md')).toBeVisible({ timeout: 15_000 })
    const editor = win.locator('.monaco-editor:visible').first()
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await editor.click()
    await win.keyboard.type('note from the human')
    await expect
      .poll(() => readFileSync(join(folder, 'PAD.md'), 'utf8'), { timeout: 10_000 })
      .toContain('note from the human')

    writeFileSync(join(folder, 'PAD.md'), 'note from the human\n\nadded by an agent\n')
    await expect(win.locator('.monaco-editor:visible .view-lines').first()).toContainText(
      'added by an agent',
      { timeout: 15_000 },
    )
    await expect(win.getByTestId('artifact-row')).toHaveCount(1)
  } finally {
    await quitApp(first.app)
  }

  first = await launchWindow(dataHome)
  try {
    const { win } = first
    await expect(win.locator('.pane-tab').first()).toBeVisible({ timeout: 20_000 })
    await showFiles(win)
    await expect(artifactRow(win, 'report.md')).toBeVisible({ timeout: 15_000 })
    expect(readdirSync(folder).sort()).toEqual(['PAD.md', 'report.md'])
  } finally {
    await quitApp(first.app)
  }
})

test('a CSV artifact opens as a table and a mermaid block in Markdown is drawn as an image', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'cities.csv'), 'city,count\nTaipei,3\n"Hsinchu, East",4\n')
  writeFileSync(
    join(home, 'plan.md'),
    '# Plan\n\n```mermaid\ngraph TD\n  Start --> Done\n```\n\n<script>document.title = "ran"</script>\n',
  )
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, editor: { markdownPreview: true } })
  const { app, win } = await launchWindow(dataHome)
  try {
    await openWorkspace(win)
    await run(
      win,
      'cp ~/cities.csv ~/plan.md "$OSTIA_ARTIFACTS/" && ostia "$OSTIA_ARTIFACTS/cities.csv"',
    )
    const viewer = win.locator('[data-testid="file-viewer"]:visible')
    await expect(viewer).toHaveAttribute('data-view-type', 'csv.table', { timeout: 20_000 })
    await expect
      .poll(() => viewerGuestText(app, { viewType: 'csv.table' }), { timeout: 20_000 })
      .toContain('Hsinchu, East')
    await win.locator('.pane-tab:visible').last().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Open With…' }).click()
    await win.getByRole('radio', { name: 'Text editor' }).click()
    await win.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(viewer).toHaveCount(0)
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText('Taipei,3')

    await terminalTab(win).click()
    await run(win, 'ostia "$OSTIA_ARTIFACTS/plan.md"')
    const diagram = win.getByTestId('mermaid-diagram')
    await expect(diagram).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(20)
    expect(await diagram.getAttribute('src')).toMatch(/^blob:/)
    const preview = win.locator('.markdown-preview')
    expect(await preview.locator('svg, script').count()).toBe(0)
    expect(await win.title()).not.toBe('ran')
  } finally {
    await quitApp(app)
  }
})

test('the artifact chip menu draws the unread dot apart from the time', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const { app, win } = await launchWindow(dataHome)
  try {
    await openWorkspace(win)
    await run(
      win,
      'printf "a" > "$OSTIA_ARTIFACTS/a.md" && printf "b" > "$OSTIA_ARTIFACTS/b.md" && ostia open -b "$OSTIA_ARTIFACTS/a.md" "$OSTIA_ARTIFACTS/b.md"',
    )
    const chip = win.getByRole('button', { name: 'Artifacts from this pane' })
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await run(win, 'printf "more" >> "$OSTIA_ARTIFACTS/b.md"')
    await expect(win.getByTestId('artifact-chip-dot')).toBeVisible({ timeout: 15_000 })

    await chip.click()
    const row = win.getByRole('menuitem').filter({ hasText: 'b.md' })
    const dot = row.getByRole('img', { name: 'New or changed' })
    await expect(dot).toBeVisible()
    const box = await dot.boundingBox()
    expect(box?.width).toBeGreaterThan(0)
    expect(box?.height).toBeGreaterThan(0)
    const gap = await row.locator('[data-slot="context-menu-shortcut"]').evaluate((hint) => {
      const mark = hint.querySelector('.unread-dot')
      const time = hint.lastChild
      if (!mark || !time) return -1
      const range = document.createRange()
      range.selectNodeContents(time)
      return range.getBoundingClientRect().left - mark.getBoundingClientRect().right
    })
    expect(gap).toBeGreaterThanOrEqual(4)
  } finally {
    await quitApp(app)
  }
})
