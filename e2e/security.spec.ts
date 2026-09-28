import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'

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

    const passwd = await win.evaluate(() =>
      (window as unknown as PineFs).pine.fs.read('/etc/passwd'),
    )
    expect(passwd).toBeNull()

    const escaped = await win.evaluate(() =>
      (window as unknown as PineFs).pine.fs.read('~/../../../../etc/passwd'),
    )
    expect(escaped).toBeNull()

    const wrote = await win.evaluate(() =>
      (window as unknown as PineFs).pine.fs.write('/tmp/pine-e2e-should-not-exist.txt', 'x'),
    )
    expect(wrote).toBe(false)

    const homeList = await win.evaluate(() => (window as unknown as PineFs).pine.fs.list('~'))
    expect(Array.isArray(homeList)).toBe(true)
    expect(homeList.length).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
