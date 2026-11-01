import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { askToQuit, newTerminalWorkspace, openWorkspace, runInTerminal } from './helpers'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  exitedWithin,
  expect,
  stopTrace,
  test,
} from './test'

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
      '     ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude "$last" >/dev/null 2>&1',
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
  if (asked)
    await dialog
      .getByRole('button', { name: 'Quit' })
      .click()
      .catch(() => {})
}

const NATIVE_QUIT_MARKER = 'native-quit-asked'

async function answerNativeQuitPrompt(app: ElectronApplication, dataHome: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, marker) => {
      dialog.showMessageBox = (async () => {
        process.getBuiltinModule('node:fs').writeFileSync(marker, 'asked')
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    },
    join(dataHome, NATIVE_QUIT_MARKER),
  )
}

async function stopApp({ app, win }: Launched, how: 'quit' | NodeJS.Signals): Promise<void> {
  const done = exitedWithin(app.process(), EXIT_TIMEOUT_MS)
  if (how === 'quit') {
    await askToQuit(app)
    await confirmQuitIfAsked(win, done)
  } else {
    await stopTrace(app)
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

const shownRows = (win: Page) => win.locator('.pane-slot:not([data-hidden]) .terminal-text')

async function runInShownTerminal(win: Page, command: string): Promise<void> {
  await runInTerminal(win, command, win.locator('.pane-slot:not([data-hidden]) .ghostty-host').last())
}

const agentWorkspace = (i: number): boolean => i >= 2 && i % 2 === 0

function agentSession(i: number): string {
  return `e2e-session-${i}`
}

async function openWorkspaces(win: Page, dataHome: string, agents = false): Promise<Saved> {
  await openWorkspace(win)
  await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
  await expect(win.locator('.ghostty-host')).toHaveCount(2, { timeout: 15_000 })
  let agentCount = 0
  for (let i = 1; i < WORKSPACES; i++) {
    await newTerminalWorkspace(win)
    if (agents && agentWorkspace(i)) {
      await runInShownTerminal(win, `claude ${agentSession(i)}`)
      await expect(shownRows(win).last()).toContainText('fake-agent-ready', { timeout: 15_000 })
      agentCount++
    } else if (i % 2 === 1) {
      await runInShownTerminal(win, `while true; do echo tick-${i}; sleep 1; done`)
    }
  }
  await expect(win.locator('.rail-row')).toHaveCount(WORKSPACES)
  const expected = {
    workspaces: WORKSPACES,
    panes: WORKSPACES + 1,
    resumable: agentCount,
    agentsRunning: agentCount,
  }
  await expect.poll(() => saved(dataHome), { timeout: 15_000 }).toEqual(expected)
  return expected
}

async function expectRestored(dataHome: string, expected: Saved): Promise<void> {
  const next = await launchApp(dataHome)
  try {
    await expect(next.win.locator('.rail-row')).toHaveCount(expected.workspaces, {
      timeout: 15_000,
    })
    await expect(next.win.locator('.ghostty-host').first()).toBeVisible({ timeout: 15_000 })
    for (let i = 1; i < WORKSPACES; i++) {
      if (expected.agentsRunning === 0 || !agentWorkspace(i)) continue
      await next.win.locator('.rail-row').nth(i).click()
      await expect(
        shownRows(next.win).filter({
          hasText: new RegExp(`fake-agent-resumed .*--resume ${agentSession(i)}\\b`),
        }),
      ).toHaveCount(1, { timeout: 20_000 })
    }
  } finally {
    await stopApp(next, 'quit')
  }
  expect({ ...saved(dataHome), agentsRunning: 0 }).toEqual({ ...expected, agentsRunning: 0 })
}

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
  seedSettings(dataHome, DEFAULT_QUIT_SETTINGS)
})

async function roundTrip(how: 'quit' | NodeJS.Signals): Promise<void> {
  seedSettings(dataHome, { ...DEFAULT_QUIT_SETTINGS, agents: { autoResume: true } })
  const first = await launchApp(dataHome)
  const scrollback = join(dataHome, 'ostia', 'scrollback.json')
  let expected: Saved | null = null
  try {
    expected = await openWorkspaces(first.win, dataHome, true)
    rmSync(scrollback, { force: true })
  } finally {
    await stopApp(first, how)
  }
  if (how === 'SIGTERM')
    expect(existsSync(scrollback), 'scrollback was not saved on SIGTERM').toBe(true)
  expect(saved(dataHome)).toEqual(expected)
  await expectRestored(dataHome, expected)
}

test('every workspace, pane and agent comes back after quit', { tag: '@core' }, async () => {
  test.setTimeout(150_000)
  await roundTrip('quit')
})

for (const how of ['SIGTERM', 'SIGKILL'] as const) {
  test(`every workspace, pane and agent comes back after ${how}`, async () => {
    test.setTimeout(150_000)
    await roundTrip(how)
  })
}

test('every restored terminal has a shell after a cold start, shown or not', async () => {
  test.setTimeout(120_000)
  seedSettings(dataHome, { ...DEFAULT_QUIT_SETTINGS, agents: { autoResume: false } })
  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
    await newTerminalWorkspace(first.win)
    await expect(first.win.locator('.rail-row')).toHaveCount(2)
    await expect
      .poll(() => saved(dataHome), { timeout: 10_000 })
      .toEqual({ workspaces: 2, panes: 2, resumable: 0, agentsRunning: 0 })
  } finally {
    await stopApp(first, 'quit')
  }

  const second = await launchApp(dataHome)
  try {
    await expect(second.win.locator('.rail-row')).toHaveCount(2, { timeout: 15_000 })
    const count =
      'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const t=JSON.parse(s).filter((p)=>p.kind==="terminal");console.log("withpid="+t.filter((p)=>p.pid).length+"/"+t.length)})'
    await runInShownTerminal(
      second.win,
      `for i in 1 2 3 4 5; do ostia pane list --json | ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${count}'; sleep 1; done`,
    )
    await expect(shownRows(second.win).last()).toContainText('withpid=2/2', { timeout: 15_000 })
  } finally {
    await stopApp(second, 'quit')
  }
})

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
  await answerNativeQuitPrompt(second.app, dataHome)
  await stopApp(second, 'quit')
  if (existsSync(join(dataHome, NATIVE_QUIT_MARKER)))
    test.info().annotations.push({ type: 'native-quit-prompt', description: 'answered Quit' })
  expect(saved(dataHome)).toEqual(expected)

  const third = await launchApp(dataHome)
  await expect(third.win.locator('.rail-row')).toHaveCount(WORKSPACES, { timeout: 15_000 })
  await stopApp(third, 'quit')
  expect(saved(dataHome)).toEqual(expected)

  await expectRestored(dataHome, expected)
})
