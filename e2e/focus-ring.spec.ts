import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

type Indicator = {
  focused: boolean
  outlineStyle: string
  boxShadow: string
  borderColor: string
  radius: string
}

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

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
  await control.page().waitForTimeout(300)
  expect(await indicator(control)).toEqual({ ...rest, focused: true })
}

test('a clicked Settings row shows no focus ring, also after a modifier or a chord', async () => {
  const { app, win } = await launch()
  try {
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
  } finally {
    await app.close()
  }
})

test('a Settings row clicked after the Settings chord shows no focus ring', async () => {
  const { app, win } = await launch()
  try {
    await win.keyboard.press(chords.openSettings)
    const row = settingsRow(win, 'Terminal')
    await expect(row).toBeVisible()
    const rest = await indicator(row)
    await row.click()
    await expectNoIndicator(row, rest)
    await win.keyboard.press('Control')
    await expectNoIndicator(row, rest)
  } finally {
    await app.close()
  }
})

test('Tab onto a Settings row shows exactly one focus indicator and keeps its radius', async () => {
  const { app, win } = await launch()
  try {
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
    await win.waitForTimeout(300)
    const focused = await indicator(row)
    expect(focused).toEqual({ ...rest, focused: true, outlineStyle: 'solid' })
    await win.keyboard.press('Control')
    expect((await indicator(row)).outlineStyle).toBe('solid')
  } finally {
    await app.close()
  }
})
