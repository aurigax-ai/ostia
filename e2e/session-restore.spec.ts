import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

/**
 * Session restore across a real app restart (docs/ARCHITECTURE.md §"Autosave + resume").
 *
 * This is the only place the feature can actually be proven: it needs a real pty writing
 * real output, a real quit that fires `before-quit`, and a second process reading what the
 * first one left on disk. Unit tests cover the pieces (`main/sessionSnapshot.test.ts`,
 * `renderer/layout/snapshot.test.ts`, `renderer/stores/persistence.test.ts`); only this
 * proves they add up to "quit and come back to where you were".
 *
 * `isolatedLaunch` gives each test a throwaway data + config home, so the suite reads and
 * writes its own `pine/sessions.json` + `pine/scrollback.json` — and, crucially for the
 * "restore off" case below, its own `settings.json` — never the developer's.
 */

interface Launched {
  app: ElectronApplication
  win: Page
}

/** Launch the built app with its stores + settings redirected into `dataHome`. */
async function launchApp(dataHome: string): Promise<Launched> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

/** Wait for the shell to draw a prompt, so we never type into a not-yet-ready pty. */
async function waitForShellPrompt(win: Page): Promise<void> {
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 15_000 })
}

async function waitForTerminalFocus(win: Page): Promise<void> {
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
}

/**
 * Quit through `app.quit()` rather than only tearing down windows: the scrollback dump hangs
 * off `before-quit`, which is the path a real ⌘Q takes. Deferred by a tick so `evaluate`
 * can return before the process starts exiting under it.
 */
async function quitApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {
      // the app was already on its way out
    })
  await app.close().catch(() => {
    // already gone — quit() got there first
  })
}

/**
 * One data home per TEST, not per launch (unlike every other spec): the whole point here is
 * that a second launch reads what the first one wrote.
 */
let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test('restores the pane layout and terminal history after a restart', async () => {
  const marker = `pine_restore_${Date.now()}`

  // ── First run: leave a distinctive workspace behind ──
  const first = await launchApp(dataHome)
  try {
    await waitForShellPrompt(first.win)
    await expect(first.win.locator('.pane.active')).toBeVisible({ timeout: 15_000 })

    // Output the marker from the shell (echoed input alone wouldn't prove the pty ran).
    const term = first.win.locator('.xterm').first()
    await term.click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })

    // Split so the restored layout is distinguishable from a fresh one-pane boot.
    await first.win.locator('.pane.active .pane-actions .iconbtn').first().click()
    await expect(first.win.locator('.pane')).toHaveCount(2)
  } finally {
    await quitApp(first.app)
  }

  // Both halves must have landed: the layout (renderer autosave) and the scrollback
  // (main's `before-quit` dump). Asserting the files directly localises a failure to the
  // write side rather than leaving it to look like a restore bug.
  const snapshotFile = join(dataHome, 'pine', 'sessions.json')
  const scrollbackFile = join(dataHome, 'pine', 'scrollback.json')
  expect(existsSync(snapshotFile), 'workspace snapshot was not written at quit').toBe(true)
  expect(existsSync(scrollbackFile), 'scrollback was not written at quit').toBe(true)
  expect(readFileSync(scrollbackFile, 'utf8')).toContain(marker)

  // ── Second run: the workspace comes back ──
  const second = await launchApp(dataHome)
  try {
    // Two panes, not the single seeded terminal a cold boot would show.
    await expect(second.win.locator('.pane')).toHaveCount(2, { timeout: 15_000 })
    // ...and a pane replays the output of a command run in the PREVIOUS process, under the
    // seam main writes ahead of the fresh shell's first prompt.
    await expect(second.win.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
    await expect(second.win.locator('.workzone')).toContainText('session restored', {
      timeout: 15_000,
    })
  } finally {
    await quitApp(second.app)
  }
})

test('boots a single fresh session when there is nothing to restore', async () => {
  // The empty-XDG case is the upgrade path for every existing install — a missing snapshot
  // must degrade to a normal cold boot, not to an empty or broken window.
  const { app, win } = await launchApp(dataHome)
  try {
    await waitForShellPrompt(win)
    await expect(win.locator('.pane')).toHaveCount(1)
    await expect(win.locator('.workzone')).not.toContainText('session restored')
  } finally {
    await quitApp(app)
  }
})

test('erases stored history when session restore is switched off', async () => {
  const first = await launchApp(dataHome)
  try {
    await waitForShellPrompt(first.win)
  } finally {
    await quitApp(first.app)
  }
  expect(existsSync(join(dataHome, 'pine', 'sessions.json'))).toBe(true)

  // Turning the setting off must remove what is already on disk — leaving a stale copy
  // would keep a record of the user's terminals after they asked for it to stop. Driven
  // through the real Settings toggle, which also covers that the new row renders.
  const second = await launchApp(dataHome)
  try {
    await waitForShellPrompt(second.win)
    await second.win.keyboard.press('Control+,') // app.openSettings
    const settings = second.win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    // Only the selected section renders (Appearance by default) — the toggle lives under Terminal.
    await settings.getByRole('button', { name: 'Terminal', exact: true }).click()

    const toggle = settings.getByLabel('Restore session on launch')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()

    await expect
      .poll(() => existsSync(join(dataHome, 'pine', 'sessions.json')), { timeout: 10_000 })
      .toBe(false)
  } finally {
    await quitApp(second.app)
  }
})
