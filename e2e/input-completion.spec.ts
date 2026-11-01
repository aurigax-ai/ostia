import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, type Page, test } from './test'

function seedHome(home: string): void {
  mkdirSync(join(home, 'my dir'), { recursive: true })
  writeFileSync(join(home, 'my dir', 'a file.txt'), 'ostia_spaced_content\n')
}

type Input = ReturnType<Page['getByRole']>

async function typeAndTab(win: Page, input: Input, text: string): Promise<void> {
  await input.fill('')
  await win.keyboard.type(text)
  await win.keyboard.press('Tab')
}

test('the input editor completes a quoted path and the shell runs it', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    behavior: {
      ...CANVAS_RENDERER_SETTINGS.behavior,
      inputMode: 'editor',
      liveFileSuggestions: false,
    },
  })
  const launch = isolatedLaunch(dataHome)
  seedHome(launch.home)
  const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: '/bin/bash' } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.terminal-text').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()
    await typeAndTab(win, input, 'cat "my d')
    await expect(input).toHaveValue('cat "my dir/')
    await win.keyboard.type('a')
    await win.keyboard.press('Tab')
    await expect(input).toHaveValue('cat "my dir/a file.txt" ')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_spaced_content', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

for (const shell of ['/bin/zsh', '/bin/bash']) {
  test(`the input editor discovers the shell's aliases, functions and commands in ${shell}`, async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...CANVAS_RENDERER_SETTINGS,
      behavior: { ...CANVAS_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
    })
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: shell } })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const rows = win.locator('.terminal-text').first()
      const input = win.getByRole('textbox', { name: 'Command input' })
      await expect(input).toBeVisible({ timeout: 15_000 })
      await input.click()
      const run = async (line: string, seen: string): Promise<void> => {
        await win.keyboard.type(line)
        await win.keyboard.press('Enter')
        await expect(rows).toContainText(seen, { timeout: 15_000 })
        await expect(input).toBeFocused({ timeout: 15_000 })
      }

      await run(
        "alias ostia_al='echo hi'; ostia_fn() { :; }; echo ostia_defined",
        'ostia_defined\n',
      )
      await expect
        .poll(
          async () => {
            await typeAndTab(win, input, 'ostia_a')
            return input.inputValue()
          },
          { timeout: 15_000 },
        )
        .toBe('ostia_al ')
      await typeAndTab(win, input, 'ostia_f')
      await expect(input).toHaveValue('ostia_fn ')
      await typeAndTab(win, input, 'whoam')
      await expect(input).toHaveValue('whoami ')
      await typeAndTab(win, input, 'ostia_')
      await expect(win.getByRole('option', { name: 'ostia_al' })).toBeVisible()
      await expect(win.getByRole('option', { name: 'ostia_fn' })).toBeVisible()
      await win.keyboard.press('ArrowDown')
      await win.keyboard.press('Enter')
      await expect(input).toHaveValue('ostia_fn ')
    } finally {
      await app.close()
    }
  })
}
