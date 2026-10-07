import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FIXTURES = resolve(__dirname, '../test/fixtures/tools')
const MARKETPLACE = resolve(__dirname, '../out/marketplace/extensions')

function installApproved(dataHome: string, configHome: string, id: string): void {
  const target = join(configHome, PRODUCT_NAME, 'extensions', id)
  cpSync(join(MARKETPLACE, id), target, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(target, 'ostia.json'), 'utf8'))
  mkdirSync(join(dataHome, 'userData'), { recursive: true })
  writeFileSync(
    join(dataHome, 'userData', 'extensions.json'),
    JSON.stringify({ [id]: { enabled: true, approved: manifest.capabilities ?? [] } }),
  )
}

function fakeClaude(dataHome: string, promptFile: string, skillFile: string): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'for arg; do [ "$prev" = --plugin-dir ] && plugin=$arg; prev=$arg; last=$arg; done',
      `head -n 2 "$plugin/skills/trellis-card/SKILL.md" > '${skillFile}'`,
      `printf '%s' "$last" > '${promptFile}'`,
      'echo fake-agent-ready',
      'exec cat',
      '',
    ].join('\n'),
  )
  chmodSync(claude, 0o755)
  return bin
}

function panelEval(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    return guest ? String(await guest.executeJavaScript(code)) : ''
  }, script)
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

test('a Trellis card goes to a new agent or to a running one, only on the human’s clicks', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const project = join(launch.home, 'shop')
  const trellisDir = join(dataHome, 'fake-trellis')
  for (const d of [project, trellisDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(project, '.trellis'), '/DEMO\n')
  for (const f of readdirSync(join(FIXTURES, 'trellis'))) {
    copyFileSync(join(FIXTURES, 'trellis', f), join(trellisDir, f))
  }
  writeFileSync(join(trellisDir, 'consumers.json'), '[{"name":"ostia","cursor":0,"lag":0}]')
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'shop',
          kind: 'terminal',
          workDir: project,
          activePaneId: 'pane-1',
          root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', cwd: project },
        },
      ],
    }),
  )
  installApproved(dataHome, launch.env.XDG_CONFIG_HOME, 'trellis')
  const promptFile = join(dataHome, 'agent-prompt.txt')
  const skillFile = join(dataHome, 'agent-skill.txt')
  const bin = fakeClaude(dataHome, promptFile, skillFile)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${bin}:${join(FIXTURES, 'bin')}:${process.env.PATH}`,
      FAKE_TRELLIS_DIR: trellisDir,
    },
  })
  const panel = (script: string): Promise<string> => panelEval(app, script)
  const click = (selector: string): Promise<string> =>
    panel(`document.querySelector('${selector}').click(); 'ok'`)
  const exists = (selector: string): Promise<string> =>
    panel(`String(!!document.querySelector('${selector}'))`)

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(
      win
        .locator('.topbar-right .workspace-chips')
        .getByRole('button', { name: /^Trellis cards: 4/ }),
    ).toBeVisible({ timeout: 20_000 })

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Trellis: Open Board')
    await waitForPaletteSelection(win, 'Trellis: Open Board')
    await win.keyboard.press('Enter')
    await expect.poll(() => exists('[data-ref="DEMO-3"]'), { timeout: 20_000 }).toBe('true')

    await click('[data-ref="DEMO-3"]')
    await expect.poll(() => exists('[data-key="work"]'), { timeout: 15_000 }).toBe('true')
    expect(existsSync(promptFile)).toBe(false)
    await click('[data-key="work"]')
    await expect
      .poll(() => exists('[data-key="work-start-claude"]'), { timeout: 15_000 })
      .toBe('true')
    expect(await panel(`document.querySelector('.work-menu').innerText`)).toContain(
      'Send to a running agent',
    )
    await click('[data-key="work-start-claude"]')

    const agentTerminal = win.locator('.xterm-rows').filter({ hasText: 'fake-agent-ready' })
    await expect(agentTerminal).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(() => existsSync(promptFile), { timeout: 15_000 }).toBe(true)
    const prompt = readFileSync(promptFile, 'utf8')
    expect(prompt.split('\n')[0]).toBe('Work on Trellis card DEMO-3: Write the rollback runbook')
    expect(prompt).toContain('Follow the trellis-card skill')
    expect(readFileSync(skillFile, 'utf8')).toBe('---\nname: trellis-card\n')
    expect(prompt).toContain('`trellis card show DEMO-3`')
    expect(prompt).toContain('`trellis card claim DEMO-3`')
    expect(prompt).toContain('`trellis card move DEMO-3 review`')
    await expect
      .poll(() => panel(`document.querySelector('[data-task="DEMO-3"]')?.innerText ?? ''`), {
        timeout: 15_000,
      })
      .toContain('claude is working on this')
    await expect(win.locator('.pane-chip', { hasText: 'DEMO-3' })).toBeVisible()

    await click('[data-ref="DEMO-5"]')
    await expect
      .poll(() => panel(`document.querySelector('.detail-title')?.innerText ?? ''`), {
        timeout: 15_000,
      })
      .toBe('Rename the config keys')
    await click('[data-key="work"]')
    await expect.poll(() => exists('[data-key="work-send"]'), { timeout: 15_000 }).toBe('true')
    await click('[data-key="work-send"]')

    const dialog = win.getByRole('dialog', { name: /Send to agent: DEMO-5/ })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByRole('radio')).toHaveCount(1)
    await expect(dialog).toContainText(project)
    const line = 'Work on Trellis card DEMO-5 (Rename the config keys)'
    await expect(dialog.getByLabel('Text to send')).toContainText(line)
    expect(occurrences((await agentTerminal.textContent()) ?? '', line)).toBe(0)
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()

    await expect(agentTerminal).toContainText(line, { timeout: 15_000 })
    await expect
      .poll(() => panel(`document.querySelector('[data-task="DEMO-5"]')?.innerText ?? ''`), {
        timeout: 15_000,
      })
      .toContain('An agent is working on this')
    await win.waitForTimeout(1000)
    const shown = (await agentTerminal.textContent()) ?? ''
    expect(occurrences(shown, line)).toBe(1)
    expect(shown).toContain('`trellis card move DEMO-5 review`.')
  } finally {
    await app.close()
  }
})
