import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'

/**
 * End-to-end proof that the fs:* path-traversal guard (src/main/pathGuard.ts, wired into the
 * handlers in src/main/index.ts) is live in the built app: driving the real preload bridge from
 * the renderer, a read outside the allowed roots is blocked, while a read inside home works.
 * The terminal is deliberately NOT confined — only the explorer/editor fs handlers are.
 */

// Minimal typing for the preload bridge surface this spec touches (e2e/ isn't in the tsconfig).
type PineFs = {
  pine: {
    fs: {
      read: (p: string) => Promise<string | null>
      list: (p: string) => Promise<{ name: string; dir: boolean }[]>
      write: (p: string, c: string) => Promise<boolean>
    }
  }
}

test('fs:* is confined to allowed roots (blocks /etc/passwd + ../ escapes)', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    // Absolute path outside home → blocked (null), even though the OS file is world-readable
    // and `cat /etc/passwd` in the terminal still works.
    const passwd = await win.evaluate(() =>
      (window as unknown as PineFs).pine.fs.read('/etc/passwd'),
    )
    expect(passwd).toBeNull()

    // A `../` escape above home → blocked.
    const escaped = await win.evaluate(() =>
      (window as unknown as PineFs).pine.fs.read('~/../../../../etc/passwd'),
    )
    expect(escaped).toBeNull()

    // A write outside the roots → rejected (false), no file created.
    const wrote = await win.evaluate(() =>
      (window as unknown as PineFs).pine.fs.write('/tmp/pine-e2e-should-not-exist.txt', 'x'),
    )
    expect(wrote).toBe(false)

    // A listing INSIDE home resolves normally (the guard allows the user's own tree).
    const homeList = await win.evaluate(() => (window as unknown as PineFs).pine.fs.list('~'))
    expect(Array.isArray(homeList)).toBe(true)
    expect(homeList.length).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
