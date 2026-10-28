import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, type Page, test } from './test'

function seedHome(home: string): void {
  mkdirSync(join(home, 'ostia_alpha'), { recursive: true })
  mkdirSync(join(home, 'ostia_beta'), { recursive: true })
  mkdirSync(join(home, 'my dir'), { recursive: true })
  writeFileSync(join(home, 'my dir', 'a file.txt'), 'ostia_spaced_content\n')
  writeFileSync(join(home, '.ostia_hidden'), '')
  writeFileSync(join(home, 'solo_file.txt'), '')
  symlinkSync(join(home, 'ostia_alpha'), join(home, 'linkdir'))
}

type Input = ReturnType<Page['getByRole']>

async function typeAndTab(win: Page, input: Input, text: string): Promise<void> {
  await input.fill('')
  await win.keyboard.type(text)
  await win.keyboard.press('Tab')
}

for (const shell of ['/bin/zsh', '/bin/bash']) {
  test(`the input editor completes paths like ${shell} does`, async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
    })
    const launch = isolatedLaunch(dataHome)
    seedHome(launch.home)
    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: shell } })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const rows = win.locator('.xterm-rows').first()
      const input = win.getByRole('textbox', { name: 'Command input' })
      await expect(input).toBeVisible({ timeout: 15_000 })
      await input.click()
      const noPaths = win.getByText('No matching paths')

      await typeAndTab(win, input, 'ls ~')
      await expect(input).toHaveValue('ls ~/')
      await expect(noPaths).toBeHidden()
      await win.keyboard.press('Tab')
      await expect(win.getByRole('option', { name: 'ostia_alpha/' })).toBeVisible()
      await expect(win.getByRole('option', { name: '.ostia_hidden' })).toBeHidden()
      await win.keyboard.press('Escape')
      await expect(win.getByRole('option', { name: 'ostia_alpha/' })).toBeHidden()
      await expect(input).toHaveValue('ls ~/')

      await typeAndTab(win, input, 'ls ~/ostia_a')
      await expect(input).toHaveValue('ls ~/ostia_alpha/')
      await typeAndTab(win, input, 'ls $HOME/ostia_b')
      await expect(input).toHaveValue('ls $HOME/ostia_beta/')
      await typeAndTab(win, input, 'ls ./ostia_b')
      await expect(input).toHaveValue('ls ./ostia_beta/')
      await typeAndTab(win, input, 'ls ostia_alpha/../ostia_b')
      await expect(input).toHaveValue('ls ostia_alpha/../ostia_beta/')
      await typeAndTab(win, input, 'cd ..')
      await expect(input).toHaveValue('cd ../')
      await typeAndTab(win, input, 'ls ~/../')
      await expect(noPaths).toBeHidden()
      await expect(input).toHaveValue('ls ~/../')
      await typeAndTab(win, input, 'ls /us')
      await expect(input).toHaveValue('ls /usr/')
      await typeAndTab(win, input, 'ls link')
      await expect(input).toHaveValue('ls linkdir/')
      await typeAndTab(win, input, 'ls .ostia')
      await expect(input).toHaveValue('ls .ostia_hidden ')
      await typeAndTab(win, input, 'ls ostia')
      await expect(win.getByRole('option', { name: 'ostia_beta/' })).toBeVisible()
      await win.keyboard.press('Escape')
      await typeAndTab(win, input, 'ls zzzz_none')
      await expect(noPaths).toBeVisible()

      await typeAndTab(win, input, 'cat my\\ d')
      await expect(input).toHaveValue('cat my\\ dir/')
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
}

const SPEC = {
  names: ['ostiacmd'],
  subcommands: [
    {
      names: ['checkout'],
      options: [{ names: ['--force'] }],
      args: [{ suggestions: [{ name: 'main' }, { name: 'feature_x' }] }],
    },
  ],
}

for (const shell of ['/bin/zsh', '/bin/bash']) {
  test(`the input editor completes commands and specs, walks history and keeps ghost text in ${shell}`, async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
    })
    const specDir = join(dataHome, 'config', 'ostia', 'completions')
    mkdirSync(specDir, { recursive: true })
    writeFileSync(join(specDir, 'ostiacmd.json'), JSON.stringify(SPEC))
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: shell } })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const rows = win.locator('.xterm-rows').first()
      const input = win.getByRole('textbox', { name: 'Command input' })
      await expect(input).toBeVisible({ timeout: 15_000 })
      await input.click()
      const run = async (line: string, seen: string): Promise<void> => {
        await win.keyboard.type(line)
        await win.keyboard.press('Enter')
        await expect(rows).toContainText(seen, { timeout: 15_000 })
        await expect(input).toBeFocused({ timeout: 15_000 })
      }
      const ghost = win.locator('.input-editor-ghost')
      const noPaths = win.getByText('No matching paths')

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

      await typeAndTab(win, input, 'ostiacmd chec')
      await expect(input).toHaveValue('ostiacmd checkout ')
      await typeAndTab(win, input, 'ostiacmd checkout --fo')
      await expect(input).toHaveValue('ostiacmd checkout --force ')
      await typeAndTab(win, input, 'ostiacmd checkout fea')
      await expect(input).toHaveValue('ostiacmd checkout feature_x ')
      await typeAndTab(win, input, 'ostiacmd checkout -')
      await expect(input).toHaveValue('ostiacmd checkout --force ')
      await input.fill('')

      await run('echo ostia_walk_a', 'ostia_walk_a\n')
      await run('echo ostia_walk_b', 'ostia_walk_b\n')
      await win.keyboard.type('echo ostia_walk')
      await win.keyboard.press('ArrowUp')
      await expect(input).toHaveValue('echo ostia_walk_b')
      await win.keyboard.press('ArrowUp')
      await expect(input).toHaveValue('echo ostia_walk_a')
      await win.keyboard.press('ArrowDown')
      await expect(input).toHaveValue('echo ostia_walk_b')
      await win.keyboard.press('ArrowDown')
      await expect(input).toHaveValue('echo ostia_walk')
      await input.fill('')

      await run('true -zq', 'true -zq')
      await run('echo ostia_gh_one ostia_gh_two', 'ostia_gh_one ostia_gh_two\n')
      await win.keyboard.type('true -z')
      await expect(ghost).toHaveText('q')
      await win.keyboard.press('Tab')
      await expect(noPaths).toBeHidden()
      await expect(input).toHaveValue('true -z')
      await expect(ghost).toHaveText('q')
      await win.keyboard.press('ArrowRight')
      await expect(input).toHaveValue('true -zq')
      await input.fill('')

      await win.keyboard.type('echo ostia_gh_o')
      await expect(ghost).toHaveText('ne ostia_gh_two')
      await win.keyboard.press('Control+ArrowRight')
      await expect(input).toHaveValue('echo ostia_gh_one')
      await win.keyboard.press('End')
      await expect(input).toHaveValue('echo ostia_gh_one ostia_gh_two')
    } finally {
      await app.close()
    }
  })
}
