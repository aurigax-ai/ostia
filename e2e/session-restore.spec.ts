import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'

const WORKSPACES = 5
const EXIT_TIMEOUT_MS = 15_000
const DEFAULT_QUIT_SETTINGS = { behavior: { gpuAcceleration: false } }

interface Launched {
  app: ElectronApplication
  win: Page
}

function fakeAgentBin(dataHome: string): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *--resume*) echo "fake-agent-resumed $*" ;;',
      '  *) for arg; do last=$arg; done',
      '     ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" resume-token claude "$last" >/dev/null 2>&1',
      '     echo fake-agent-ready ;;',
      'esac',
      'exec cat',
      '',
    ].join('\n'),
  )
  chmodSync(claude, 0o755)
  return bin
}

async function launchApp(dataHome: string): Promise<Launched> {
  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    app.process().kill('SIGKILL')
    throw err
  }
}

function exited(app: ElectronApplication): Promise<boolean> {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function confirmQuitIfAsked(win: Page, done: Promise<boolean>): Promise<void> {
  const dialog = win.getByRole('dialog')
  const asked = await Promise.race([
    done.then(() => false),
    dialog
      .getByRole('button', { name: 'Quit' })
      .waitFor({ timeout: EXIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false),
  ])
  if (asked) await dialog.getByRole('button', { name: 'Quit' }).click().catch(() => {})
}

async function stopApp({ app, win }: Launched, how: 'quit' | NodeJS.Signals): Promise<void> {
  const done = exited(app)
  if (how === 'quit') {
    await app
      .evaluate(({ app: electronApp }) => {
        setTimeout(() => electronApp.quit(), 0)
      })
      .catch(() => {})
    await confirmQuitIfAsked(win, done)
  } else {
    app.process().kill(how)
  }
  const ok = await done
  if (!ok) app.process().kill('SIGKILL')
  expect(ok, `the app did not exit within ${EXIT_TIMEOUT_MS} ms after ${how}`).toBe(true)
}

interface Saved {
  workspaces: number
  panes: number
  resumable: number
  agentsRunning: number
}

function saved(dataHome: string): Saved | null {
  const file = join(dataHome, 'ostia', 'workspaces.json')
  if (!existsSync(file)) return null
  const snapshot = JSON.parse(readFileSync(file, 'utf8'))
  const panes: Record<string, unknown>[] = []
  const walk = (node: Record<string, unknown> | undefined): void => {
    if (!node) return
    if (node.type === 'pane') panes.push(node)
    for (const child of (node.children as Record<string, unknown>[] | undefined) ?? []) walk(child)
  }
  for (const workspace of snapshot.workspaces) walk(workspace.root)
  return {
    workspaces: snapshot.workspaces.length,
    panes: panes.length,
    resumable: panes.filter((p) => p.resume).length,
    agentsRunning: panes.filter((p) => p.agentRunning === true).length,
  }
}

const shownRows = (win: Page) => win.locator('.pane-slot:not([data-hidden]) .xterm-rows')

async function newTerminalWorkspace(win: Page): Promise<void> {
  const before = await win.locator('.xterm').count()
  await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.xterm')).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(shownRows(win).last()).toContainText(PROMPT, { timeout: 15_000 })
}

async function runInShownTerminal(win: Page, command: string): Promise<void> {
  await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function openWorkspaces(win: Page, dataHome: string): Promise<Saved> {
  await openWorkspace(win)
  await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
  await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
  for (let i = 1; i < WORKSPACES; i++) {
    await newTerminalWorkspace(win)
    if (i % 2 === 1) await runInShownTerminal(win, `while true; do echo tick-${i}; sleep 1; done`)
  }
  await expect(win.locator('.rail-row')).toHaveCount(WORKSPACES)
  const expected = { workspaces: WORKSPACES, panes: WORKSPACES + 1, resumable: 0, agentsRunning: 0 }
  await expect.poll(() => saved(dataHome), { timeout: 10_000 }).toEqual(expected)
  return expected
}

async function expectRestored(dataHome: string, expected: Saved): Promise<void> {
  const next = await launchApp(dataHome)
  try {
    await expect(next.win.locator('.rail-row')).toHaveCount(expected.workspaces, {
      timeout: 15_000,
    })
    await expect(next.win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  } finally {
    await stopApp(next, 'quit')
  }
  expect(saved(dataHome)).toEqual(expected)
}

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
  seedSettings(dataHome, DEFAULT_QUIT_SETTINGS)
})

for (const how of ['quit', 'SIGTERM', 'SIGKILL'] as const) {
  test(`every workspace and pane comes back after ${how}`, async () => {
    test.setTimeout(120_000)
    const first = await launchApp(dataHome)
    let expected: Saved | null = null
    try {
      expected = await openWorkspaces(first.win, dataHome)
    } finally {
      await stopApp(first, how)
    }
    expect(saved(dataHome)).toEqual(expected)
    await expectRestored(dataHome, expected)
  })
}

test('quitting right after a restart keeps every workspace', async () => {
  test.setTimeout(150_000)
  const first = await launchApp(dataHome)
  let expected: Saved | null = null
  try {
    expected = await openWorkspaces(first.win, dataHome)
  } finally {
    await stopApp(first, 'SIGTERM')
  }

  const second = await launchApp(dataHome)
  await stopApp(second, 'quit')
  expect(saved(dataHome)).toEqual(expected)

  const third = await launchApp(dataHome)
  await expect(third.win.locator('.rail-row')).toHaveCount(WORKSPACES, { timeout: 15_000 })
  await stopApp(third, 'quit')
  expect(saved(dataHome)).toEqual(expected)

  await expectRestored(dataHome, expected)
})

for (const how of ['quit', 'SIGTERM', 'SIGKILL'] as const) {
  test(`with auto-resume on, every agent resumes after ${how}`, async () => {
    test.setTimeout(150_000)
    seedSettings(dataHome, { ...DEFAULT_QUIT_SETTINGS, agents: { autoResume: true } })
    const first = await launchApp(dataHome)
    try {
      for (let i = 0; i < WORKSPACES; i++) {
        if (i === 0) await openWorkspace(first.win)
        else await newTerminalWorkspace(first.win)
        await runInShownTerminal(first.win, `claude e2e-session-${i}`)
        await expect(shownRows(first.win).last()).toContainText('fake-agent-ready', {
          timeout: 15_000,
        })
      }
      await expect
        .poll(() => saved(dataHome), { timeout: 15_000 })
        .toEqual({
          workspaces: WORKSPACES,
          panes: WORKSPACES,
          resumable: WORKSPACES,
          agentsRunning: WORKSPACES,
        })
    } finally {
      await stopApp(first, how)
    }

    const second = await launchApp(dataHome)
    try {
      await expect(second.win.locator('.rail-row')).toHaveCount(WORKSPACES, { timeout: 15_000 })
      for (let i = 0; i < WORKSPACES; i++) {
        await expect(
          second.win
            .locator('.xterm-rows')
            .filter({ hasText: new RegExp(`fake-agent-resumed .*--resume e2e-session-${i}\\b`) }),
        ).toHaveCount(1, { timeout: 20_000 })
      }
    } finally {
      second.app.process().kill('SIGKILL')
    }
  })
}
