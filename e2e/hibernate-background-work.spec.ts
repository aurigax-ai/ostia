import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, openWorkspace } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 120_000 })

const MARK = 'background-work-512'
const CHILD_PID_FILE = 'background-child.pid'

const AGENT = [
  '#!/bin/sh',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-background',
  'ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "$(dirname "$0")/agent.js" "$@"',
  '',
].join('\n')

const AGENT_PROGRAM = [
  'const { spawn } = require("node:child_process")',
  'const { writeFileSync } = require("node:fs")',
  'const { join } = require("node:path")',
  'if (!process.argv.includes("--idle")) {',
  '  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })',
  `  writeFileSync(join(process.env.HOME, "${CHILD_PID_FILE}"), String(child.pid))`,
  '}',
  `console.log("${MARK} up")`,
  'setInterval(() => {}, 60000)',
  '',
].join('\n')

interface Launched {
  app: ElectronApplication
  win: Page
  home: string
}

async function launchWithAgent(command: string): Promise<Launched> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const bin = fakeAgentBin(dataHome, AGENT)
  writeFileSync(join(bin, 'agent.js'), AGENT_PROGRAM)
  const home = isolatedHome(dataHome)
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: { ...options.env, HOME: home, PATH: `${bin}:${options.env.PATH ?? ''}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText(`${MARK} up`, {
    timeout: 15_000,
  })
  return { app, win, home }
}

async function hibernateAgents(win: Page): Promise<void> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Hibernate agents' }).click()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('an agent that left a background process running is not hibernated, and the human is told why', async () => {
  const { app, win, home } = await launchWithAgent('claude')
  const pidFile = join(home, CHILD_PID_FILE)
  await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true)
  const child = Number(readFileSync(pidFile, 'utf8'))
  try {
    await hibernateAgents(win)
    const dialog = win.getByRole('alertdialog', { name: 'Agents left running: 1' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByText('Running a command or a background process: 1')).toBeVisible()
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toHaveCount(0)

    await expect(win.getByRole('tab').first().getByLabel('Hibernated')).toHaveCount(0)
    await expect(win.locator('.hibernated-view')).toHaveCount(0)
    expect(alive(child)).toBe(true)
  } finally {
    if (alive(child)) process.kill(child)
    await app.close()
  }
})

test('the same agent with no background process is hibernated', async () => {
  const { app, win } = await launchWithAgent('claude --idle')
  try {
    await hibernateAgents(win)
    await expect(win.getByRole('tab').first().getByLabel('Hibernated')).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.getByRole('alertdialog')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
