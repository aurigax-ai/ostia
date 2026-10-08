import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type FakeProvider, fakeAssistantSettings, startFakeProvider } from './fakeProvider'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const UI_FAMILY = 'Geist Variable'
const CODE_FAMILY = 'Geist Mono Variable'

const FONT_PROBE = `(selector) => {
  const el = document.querySelector(selector)
  if (!el) return null
  const style = getComputedStyle(el)
  const first = style.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
  const loaded = [...document.fonts].some((f) => f.family.replace(/^["']|["']$/g, '') === first && f.status === 'loaded')
  return { first, size: style.fontSize, loaded }
}`

type Probe = { first: string; size: string; loaded: boolean } | null

async function probe(win: Page, selector: string): Promise<Probe> {
  return win.evaluate(
    async ([fn, sel]) => {
      await document.fonts.ready
      return (0, eval)(fn)(sel)
    },
    [FONT_PROBE, selector] as const,
  )
}

test.describe('fonts follow the settings everywhere', () => {
  let provider: FakeProvider

  test.beforeAll(async () => {
    provider = await startFakeProvider(() => 'Run it:\n\n```bash\nnode sample.ts\n```\n')
  })

  test.afterAll(() => provider.close())

  test('the UI, settings lists, keycaps, chat code and the git panel use the chosen UI and code fonts', async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    const home = join(dataHome, 'home')
    mkdirSync(home, { recursive: true })
    const vcs = (...args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: home })
    }
    vcs('init', '-q', '-b', 'main')
    vcs('config', 'user.email', 'e2e@example.com')
    vcs('config', 'user.name', 'E2E')
    writeFileSync(join(home, 'notes.txt'), 'first line\n')
    writeFileSync(join(home, '.gitignore'), '*\n!notes.txt\n!.gitignore\n')
    vcs('add', 'notes.txt', '.gitignore')
    vcs('commit', '-q', '-m', 'init')
    writeFileSync(join(home, 'notes.txt'), 'first line\nsecond line\n')
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      appearance: {
        ui: { family: UI_FAMILY, size: 14, weight: 400 },
        editor: { family: CODE_FAMILY, size: 13, weight: 400 },
      },
      assistant: fakeAssistantSettings(provider.url),
    })

    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)

      expect(await probe(win, 'body')).toEqual({ first: UI_FAMILY, size: '14px', loaded: true })
      expect(await probe(win, 'header.topbar kbd')).toMatchObject({
        first: UI_FAMILY,
        loaded: true,
      })
      expect(await probe(win, '.pane-tab')).toMatchObject({ first: UI_FAMILY, size: '13px' })

      await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
      const settings = win.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Sandbox', exact: true }).click()
      const domains = settings.getByRole('group', { name: 'Allowed domains' })
      await expect(domains.locator('li').first()).toBeVisible()
      expect(await probe(win, 'fieldset li span')).toEqual({
        first: CODE_FAMILY,
        size: '13px',
        loaded: true,
      })
      await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()

      await win
        .locator('header.topbar')
        .getByRole('button', { name: /^Open chat/ })
        .click()
      const question = win.getByRole('combobox', { name: 'Your question' }).last()
      await question.fill('how do I run it')
      await question.press('Enter')
      await expect(win.locator('.ask-answer pre').last()).toContainText('node sample.ts', {
        timeout: 15_000,
      })
      expect(await probe(win, '.ask-answer .code-block-body')).toMatchObject({
        first: CODE_FAMILY,
        loaded: true,
      })

      const branchChip = win
        .locator('.topbar-right .workspace-chips .pane-chip')
        .filter({ hasText: /^main$/ })
      await expect(branchChip.first()).toBeVisible({ timeout: 15_000 })
      await branchChip.first().click()
      await expect
        .poll(() => probe(win, '.git-surface'), { timeout: 15_000 })
        .toEqual({ first: UI_FAMILY, size: '13px', loaded: true })
      await expect(win.locator('.git-surface .commit textarea.message')).toBeVisible({
        timeout: 15_000,
      })
      expect(await probe(win, '.git-surface .commit textarea.message')).toMatchObject({
        first: CODE_FAMILY,
        loaded: true,
      })
    } finally {
      await app.close()
    }
  })
})
