import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { clickWith, hoverPoint, linkPoint, type Point } from './terminalLinks'
import { _electron as electron, expect, type Page, test } from './test'

const FAKE_BIN = resolve('test/fixtures/app-links/bin')

function calls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

async function ctrlClick(win: Page, point: Point): Promise<void> {
  await hoverPoint(win, point)
  await clickWith(win, point, ['Control'])
}

test.skip(process.platform !== 'linux', 'the fake handler is a Linux xdg-open and xdg-mime pair')

test('an app link asks first, remembers a scheme the human allowed and starts the installed browser for a chrome page', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const log = join(dataHome, 'apps.log')
  mkdirSync(join(dataHome, 'applications'), { recursive: true })
  writeFileSync(
    join(dataHome, 'applications', 'fake-app.desktop'),
    '[Desktop Entry]\nName=Fake App\nExec=fake-app %u\n',
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      FAKE_APP_LOG: log,
      PATH: `${FAKE_BIN}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const card = win.getByRole('region', { name: 'Open link in an app' })
    const print = async (line: string): Promise<void> => {
      await win.locator('.xterm').filter({ visible: true }).first().click()
      await win.keyboard.type(`clear; printf '%s\\n' '${line}'`)
      await win.keyboard.press('Enter')
    }

    await print('see fakeapp://open?x=1 now')
    const fake = await linkPoint(win, /^see fakeapp/, 'fakeapp://')
    await ctrlClick(win, fake)
    await expect(card).toContainText('Open in Fake App?')
    await expect(card).toContainText('fakeapp://open?x=1')
    await card.getByRole('button', { name: 'Cancel' }).last().click()
    await expect(card).toHaveCount(0)
    expect(calls(log)).toEqual([])

    await ctrlClick(win, fake)
    await card.getByRole('checkbox', { name: "Don't ask again for fakeapp:" }).click()
    await card.getByRole('button', { name: 'Open' }).click()
    await expect.poll(() => calls(log), { timeout: 10_000 }).toEqual(['fakeapp://open?x=1'])

    await ctrlClick(win, fake)
    await expect.poll(() => calls(log), { timeout: 10_000 }).toHaveLength(2)
    await expect(card).toHaveCount(0)

    await print('see chrome://inspect/#remote-debugging now')
    const chrome = await linkPoint(win, /^see chrome/, 'chrome://')
    await ctrlClick(win, chrome)
    await expect(card).toContainText('Open in Google Chrome?')
    await card.getByRole('button', { name: 'Open' }).click()
    await expect
      .poll(() => calls(log).at(-1), { timeout: 10_000 })
      .toBe('chrome chrome://inspect/#remote-debugging')

    await print('see nohandler://x now')
    const none = await linkPoint(win, /^see nohandler/, 'nohandler://')
    await ctrlClick(win, none)
    await expect(card).toContainText('No app opens nohandler: links')
    expect(calls(log)).toHaveLength(3)
  } finally {
    await app.close()
  }
})
