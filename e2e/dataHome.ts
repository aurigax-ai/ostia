import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Per-launch isolation of everything the app persists.
 *
 * pine writes to two places outside the repo: `$XDG_DATA_HOME/pine/` (the `jsonStore` stores
 * — session snapshot, scrollback, wiki, kanban, processes, notifications) and Electron's
 * userData dir (`settings.json`). Both must be throwaway in E2E:
 *
 *   - Session restore makes every run reopen the previous one's workspace, so without a fresh
 *     data home a spec would restore the PREVIOUS spec's panes and scrollback — silently
 *     breaking pane counts and prompt assertions in specs that assume a cold boot.
 *   - A spec that changes a setting (see session-restore's "restore off" case) would otherwise
 *     rewrite the DEVELOPER's real `~/.config/pine/settings.json` and change how their app
 *     behaves afterwards. `--user-data-dir` redirects `app.getPath('userData')`, so it can't.
 *
 * Every `electron.launch` in `e2e/` should spread `isolatedLaunch()`.
 */
const created: string[] = []

/** A fresh, empty data home — i.e. "this launch has no previous run to restore". */
export function freshDataHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pine-e2e-data-'))
  created.push(dir)
  return dir
}

/**
 * Launch options pointing the app's data + config dirs at `dataHome`. Pass an existing
 * `dataHome` to give two launches the SAME storage (that's how a restore is tested); omit it
 * for the usual "cold boot, no history" case.
 */
export function isolatedLaunch(dataHome: string = freshDataHome()): {
  args: string[]
  env: Record<string, string>
} {
  return {
    args: [`--user-data-dir=${join(dataHome, 'userData')}`, '.'],
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: 'test',
      XDG_DATA_HOME: dataHome,
    },
  }
}

// Playwright has no global teardown these specs share; process exit is good enough for tmp dirs.
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})
