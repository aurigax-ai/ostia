import { chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-agent', 'agent-kit')

const FAKE_CLAUDE_JS = `
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const dir = args[args.indexOf('--plugin-dir') + 1]
for (const name of readdirSync(join(dir, 'skills')).sort()) {
  console.log('skill ' + name + ' ' + readdirSync(join(dir, 'skills', name)).sort().join(','))
}
const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks
for (const group of hooks.SessionStart || []) {
  for (const hook of group.hooks) {
    if (!hook.command.includes(' agent-hook ')) continue
    const out = execFileSync('sh', ['-c', hook.command], {
      input: JSON.stringify({ session_id: 'e2e-1', hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
    })
    console.log('context: ' + JSON.parse(out).hookSpecificOutput.additionalContext)
  }
}
`

function installAgentKit(configHome: string): void {
  const dir = join(configHome, PRODUCT_NAME, 'extensions', 'agent-kit')
  mkdirSync(dir, { recursive: true })
  for (const file of ['ostia.json', 'skills']) {
    cpSync(join(fixture, file), join(dir, file), { recursive: true })
  }
  buildSync({
    entryPoints: [join(fixture, 'main.js')],
    outfile: join(dir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
}

function fakeClaude(dataHome: string): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'fake-claude.js'), FAKE_CLAUDE_JS)
  const claude = join(bin, 'claude')
  writeFileSync(
    claude,
    '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "$(dirname "$0")/fake-claude.js" "$@"\n',
  )
  chmodSync(claude, 0o755)
  return bin
}

test('an approved extension’s declared skill and hook reach claude in a new pane', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  installAgentKit(launch.env.XDG_CONFIG_HOME)
  const bin = fakeClaude(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const approval = win.getByRole('dialog').filter({ hasText: 'Agent kit' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await expect(approval.getByText('Agent skills: agent-kit-review')).toBeVisible()
    await expect(
      approval.getByText('Hook SessionStart runs “Agent kit hook” (claude, codex)'),
    ).toBeVisible()
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()
    await openWorkspace(win)

    await win.locator('.xterm').first().click()
    await win.keyboard.type('claude')
    await win.keyboard.press('Enter')
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText('skill agent-kit-review SKILL.md,checklist.md', {
      timeout: 15_000,
    })
    await expect(rows).toContainText('context: agent-kit saw claude SessionStart for e2e-1', {
      timeout: 15_000,
    })
    await expect(rows).not.toContainText('agent-kit-undeclared')
  } finally {
    await app.close()
  }
})
