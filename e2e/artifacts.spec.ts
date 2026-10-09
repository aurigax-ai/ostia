import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  PROMPT,
  emptyState,
  emptyWorkspace,
  openWorkspace,
  quitApp,
  runInTerminal,
  terminalTab,
} from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

function run(win: Page, command: string, terminal = 0): Promise<void> {
  return runInTerminal(win, command, win.locator('.xterm:visible').nth(terminal))
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

function focusedPane(win: Page): Promise<string | null> {
  return win.evaluate(
    () => document.activeElement?.closest<HTMLElement>('.surface-host')?.dataset.paneId ?? null,
  )
}

test('a shell writes artifacts that are listed, opened and kept across a restart, and the pad is shared', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  let folder = ''
  let first = await launch(dataHome)
  try {
    const { win } = first
    await openWorkspace(win)
    await showFiles(win)
    await expect(win.getByTestId('artifact-pad')).toHaveText('Scratch Pad')
    await expect(win.getByTestId('artifact-row')).toHaveCount(0)

    folder = await printValue(win, 'ART', 'OSTIA_ARTIFACTS')
    expect(folder.startsWith(join(dataHome, 'ostia', 'artifacts'))).toBe(true)
    expect(folder.startsWith(join(dataHome, 'home'))).toBe(false)
    expect(await printValue(win, 'PAD', 'OSTIA_PAD')).toBe(join(folder, 'PAD.md'))

    await run(win, 'printf "# Report\\n\\nfirst line\\n" > "$OSTIA_ARTIFACTS/report.md"')
    const row = artifactRow(win, 'report.md')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute('data-unread', 'true')
    await row.click()
    await expect(tab(win, 'report.md')).toBeVisible({ timeout: 15_000 })
    await expect(row).not.toHaveAttribute('data-unread', 'true')
    await expect(win.locator('.pane-body:visible').last()).toContainText('first line', {
      timeout: 15_000,
    })

    await terminalTab(win).click()
    await run(win, 'printf "piped text" | ostia - --name piped.txt')
    await expect(tab(win, 'piped.txt')).toBeVisible({ timeout: 15_000 })
    await expect(artifactRow(win, 'piped.txt')).toBeVisible()
    expect(readFileSync(join(folder, 'piped.txt'), 'utf8')).toBe('piped text')

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
    await expect(win.getByTestId('artifact-row')).toHaveCount(2)
  } finally {
    await quitApp(first.app)
  }

  first = await launch(dataHome)
  try {
    const { win } = first
    await expect(win.locator('.pane-tab').first()).toBeVisible({ timeout: 20_000 })
    await showFiles(win)
    await expect(artifactRow(win, 'report.md')).toBeVisible({ timeout: 15_000 })
    await expect(artifactRow(win, 'piped.txt')).toBeVisible()
    expect(readdirSync(folder).sort()).toEqual(['PAD.md', 'piped.txt', 'report.md'])
  } finally {
    await quitApp(first.app)
  }
})

test('a scratch workspace keeps its artifacts in its own folder, which goes with it', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const { app, win } = await launch(dataHome)
  try {
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await win
      .locator('.topbar')
      .getByRole('button', { name: 'More ways to start a workspace' })
      .click()
    await win.getByRole('menuitem', { name: 'New scratch workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })

    const scratch = await printValue(win, 'DIR', 'PWD')
    const folder = await printValue(win, 'ART', 'OSTIA_ARTIFACTS')
    expect(folder).toBe(join(scratch, 'artifacts'))
    await run(win, 'echo kept-until-close > "$OSTIA_ARTIFACTS/note.md"')
    await expect.poll(() => existsSync(join(folder, 'note.md'))).toBe(true)
    expect(existsSync(join(dataHome, 'ostia', 'artifacts', '.closed'))).toBe(false)

    const row = win.locator('.rail-tab').first()
    await row.hover()
    await row.getByRole('button', { name: 'Close', exact: true }).click()
    const confirm = win.getByRole('dialog')
    await expect(confirm).toContainText('Delete 1 file in the scratch folder?')
    await confirm.getByRole('button', { name: 'Delete' }).click()
    await expect.poll(() => existsSync(scratch), { timeout: 15_000 }).toBe(false)
    expect(existsSync(join(dataHome, 'ostia', 'artifacts', '.closed'))).toBe(false)
  } finally {
    await quitApp(app)
  }
})

test('ostia shows a folder, opens a URL in an isolated browser pane, and an open from a background pane takes no focus', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'proj', 'sub'), { recursive: true })
  writeFileSync(join(home, 'proj', 'inside.txt'), 'inside')
  writeFileSync(join(home, 'proj', 'late.md'), '# opened later\n')
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.setHeader('content-type', 'text/html')
    res.end('<title>opened from the shell</title><p>hello</p>')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, capabilities: { grants: ['browse'] } })
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await expect(win.getByTestId('artifacts-section')).toHaveCount(0)
    await run(win, 'ostia ~/proj')
    await expect(win.getByTestId('artifacts-section')).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.files-crumb')).toContainText('proj')
    await expect(win.locator('.file-row').filter({ hasText: 'inside.txt' })).toBeVisible()
    await run(win, 'ostia workspace list --json')
    await expect(win.locator('.xterm:visible .xterm-rows').first()).toContainText(
      `"workDir": "${home}",`,
      { timeout: 15_000 },
    )

    await run(win, 'ostia /usr')
    await expect(win.locator('.xterm:visible .xterm-rows').first()).toContainText(
      'folders show only under the home folder',
      { timeout: 15_000 },
    )

    await win.keyboard.press('Control+Alt+Backslash')
    await expect(win.locator('.xterm:visible')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.xterm:visible .xterm-rows').nth(1)).toContainText(PROMPT, {
      timeout: 15_000,
    })
    await run(win, '(sleep 4; ostia ~/proj/late.md) > /dev/null 2>&1 &', 0)
    await win.locator('.xterm:visible').nth(1).click()
    const typing = await focusedPane(win)
    expect(typing).not.toBeNull()
    await expect(tab(win, 'late.md')).toBeVisible({ timeout: 20_000 })
    await expect(tab(win, 'late.md').locator('.pane-attn-mark')).toHaveCount(1)
    expect(await focusedPane(win)).toBe(typing)
    await win.keyboard.type('echo still-typing-here')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm:visible .xterm-rows').nth(1)).toContainText(
      'still-typing-here',
      { timeout: 10_000 },
    )
    await expect(win.locator('.monaco-editor:visible')).toHaveCount(0)

    await run(win, `ostia http://127.0.0.1:${port}/hello`, 1)
    const browser = win.locator('webview.browser-webview')
    await expect(browser).toHaveCount(1, { timeout: 20_000 })
    await expect.poll(() => seen, { timeout: 20_000 }).toContain('/hello')
    const partition = await browser.getAttribute('partition')
    expect(partition).toMatch(/^ostia-browser-/)
    expect(partition).not.toBe('persist:ostia-browser')
  } finally {
    await quitApp(app)
    await new Promise<void>((ok) => server.close(() => ok()))
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
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await run(
      win,
      'cp ~/cities.csv ~/plan.md "$OSTIA_ARTIFACTS/" && ostia "$OSTIA_ARTIFACTS/cities.csv"',
    )
    const table = win.getByTestId('csv-table')
    await expect(table.getByRole('columnheader', { name: 'city' })).toBeVisible({ timeout: 20_000 })
    await expect(table.getByRole('cell', { name: 'Hsinchu, East' })).toBeVisible()
    await win.getByRole('button', { name: 'Edit CSV source' }).click()
    await expect(win.getByTestId('csv-table')).toHaveCount(0)
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
