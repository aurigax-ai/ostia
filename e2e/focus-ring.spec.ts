import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { expectHeld, openWorkspace } from './helpers'
import {
  type ElectronApplication,
  expect,
  type Locator,
  launchShared,
  type Page,
  test,
} from './test'

type Indicator = {
  focused: boolean
  outlineStyle: string
  boxShadow: string
  borderColor: string
  radius: string
}

let app: ElectronApplication | undefined
let win: Page

test.beforeAll(async () => {
  app = await launchShared(isolatedLaunch())
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
})

test.beforeEach(async () => {
  await win.evaluate(() => {
    document.documentElement.dataset.keyboardNav = ''
  })
})

test.afterEach(async () => {
  await win.keyboard.press('Escape')
  await expect(win.getByRole('region', { name: 'Settings' })).toBeHidden()
})

test.afterAll(async () => {
  await app?.close()
})

function indicator(control: Locator): Promise<Indicator> {
  return control.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      focused: document.activeElement === el,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      borderColor: style.borderTopColor,
      radius: style.borderTopLeftRadius,
    }
  })
}

function settingsRow(win: Page, name: string): Locator {
  return win.getByRole('region', { name: 'Settings' }).getByRole('button', { name, exact: true })
}

async function expectNoIndicator(control: Locator, rest: Indicator): Promise<void> {
  await expect.poll(() => indicator(control)).toEqual({ ...rest, focused: true })
  await expectHeld(() => indicator(control), { ...rest, focused: true }, 500)
}

test('a clicked Settings row shows no focus ring, also after a modifier or a chord', async () => {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const row = settingsRow(win, 'Terminal')
  const rest = await indicator(row)
  expect(rest.outlineStyle).toBe('none')
  await row.click()
  await expectNoIndicator(row, rest)
  await win.keyboard.press('Control')
  await expectNoIndicator(row, rest)
  await win.keyboard.press(chords.palette)
  await expect(win.getByRole('dialog')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.getByRole('dialog')).toBeHidden()
  await expectNoIndicator(row, rest)
})

test('Tab onto a Settings row shows exactly one focus indicator and keeps its radius', async () => {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const row = settingsRow(win, 'Terminal')
  const rest = await indicator(row)
  await settingsRow(win, 'Appearance').click()
  await expect
    .poll(async () => {
      await win.keyboard.press('Tab')
      return (await indicator(row)).focused
    })
    .toBe(true)
  await expect.poll(async () => (await indicator(row)).outlineStyle).toBe('solid')
  await expectHeld(() => indicator(row), { ...rest, focused: true, outlineStyle: 'solid' }, 500)
  await win.keyboard.press('Control')
  expect((await indicator(row)).outlineStyle).toBe('solid')
})
