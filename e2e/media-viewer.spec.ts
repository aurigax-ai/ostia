import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { expectHeld, openWorkspace, shownTerminal, terminalTab } from './helpers'
import { recordWebm, silentWav } from './mediaFixtures'
import { clickAt, dragBetween, viewerGuestInput } from './mediaGuest'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'
import { viewerGuestRun } from './viewerGuest'

const VIEW_TYPE = 'video.video'
const LONG_SECONDS = 320

async function withMedia(
  run: (win: Page, app: ElectronApplication, home: string) => Promise<void>,
): Promise<void> {
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(dataHome)
  const home = isolatedHome(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await startFakeAgent(win)
    await run(win, app, home)
  } finally {
    await app.close()
  }
}

async function openMedia(win: Page, name: string): Promise<void> {
  const row = win.locator('.file-row').filter({ hasText: name })
  if ((await row.count()) === 0) {
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  }
  await row.click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    VIEW_TYPE,
    { timeout: 15_000 },
  )
}

function guest<T>(app: ElectronApplication, name: string, script: string): Promise<T> {
  return viewerGuestRun(app, { viewType: VIEW_TYPE, name }, script) as Promise<T>
}

async function centerOf(
  app: ElectronApplication,
  name: string,
  label: string,
): Promise<{ x: number; y: number }> {
  const at = await guest<{ x: number; y: number } | null>(
    app,
    name,
    `(() => { const b = document.querySelector('[aria-label=${JSON.stringify(label)}]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )
  if (!at) throw new Error(`no ${label} control`)
  return at
}

const currentTime = (app: ElectronApplication, name: string) =>
  guest<number>(app, name, 'document.querySelector("video")?.currentTime ?? -1')

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('a video and a long audio file play in the built-in player, and a video crop is pasted at the prompt without Enter', async () => {
  test.setTimeout(240_000)
  await withMedia(async (win, app, home) => {
    writeFileSync(join(home, 'clip.webm'), await recordWebm(win, 6))
    const wav = silentWav(LONG_SECONDS)
    expect(wav.length).toBeGreaterThan(50 * 1024 * 1024)
    writeFileSync(join(home, 'long.wav'), wav)

    await test.step('a video plays, pauses, and a dragged crop reaches the agent prompt', async () => {
      await openMedia(win, 'clip.webm')
      await expect
        .poll(
          () => guest<number>(app, 'clip.webm', 'document.querySelector("video")?.videoWidth'),
          {
            timeout: 20_000,
          },
        )
        .toBe(320)
      expect(await guest<boolean>(app, 'clip.webm', 'document.querySelector("video").paused')).toBe(
        true,
      )
      expect(await win.locator('.monaco-editor:visible').count()).toBe(0)

      const play = await centerOf(app, 'clip.webm', 'Play')
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'clip.webm' },
        clickAt(play.x, play.y),
      )
      await expect
        .poll(() => currentTime(app, 'clip.webm'), { timeout: 10_000 })
        .toBeGreaterThan(0.3)

      const pause = await centerOf(app, 'clip.webm', 'Pause')
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'clip.webm' },
        clickAt(pause.x, pause.y),
      )
      await expect
        .poll(() => guest<boolean>(app, 'clip.webm', 'document.querySelector("video").paused'))
        .toBe(true)
      const stopped = await currentTime(app, 'clip.webm')
      await expectHeld(() => currentTime(app, 'clip.webm'), stopped, 1_500)

      const frame = await guest<{ x: number; y: number; w: number; h: number }>(
        app,
        'clip.webm',
        `(() => { const s = document.querySelector('.ostia-media-stage').getBoundingClientRect(); const v = document.querySelector('video'); const k = Math.min(s.width / v.videoWidth, s.height / v.videoHeight); const w = v.videoWidth * k; const h = v.videoHeight * k; return { x: (s.width - w) / 2, y: (s.height - h) / 2, w, h } })()`,
      )
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'clip.webm' },
        dragBetween(
          { x: frame.x + frame.w * 0.1, y: frame.y + frame.h * 0.1 },
          { x: frame.x + frame.w * 0.5, y: frame.y + frame.h * 0.8 },
        ),
      )
      const bar = win.getByRole('toolbar', { name: 'Selection actions' })
      await expect(bar).toBeVisible({ timeout: 15_000 })
      await bar.getByRole('button', { name: 'Send to agent' }).click()
      await win.getByRole('menuitem').first().click()

      await terminalTab(win).click()
      const terminal = shownTerminal(win).locator('.terminal-text')
      const inserted = /@(\S*selection-\d+\S*\.md)/
      await expect(terminal).toContainText(inserted, { timeout: 15_000 })
      await expect(terminal).not.toContainText('agent-read:')
      const match = ((await terminal.textContent()) ?? '').match(inserted) as RegExpMatchArray
      const imagePath = (readFileSync(match[1], 'utf8').match(/\S+\.png/) as RegExpMatchArray)[0]
      const size = pngSize(imagePath)
      expect(Math.abs(size.width - 128)).toBeLessThanOrEqual(3)
      expect(Math.abs(size.height - 126)).toBeLessThanOrEqual(3)
      const pixel = await app.evaluate(({ nativeImage }, path) => {
        const image = nativeImage.createFromPath(path)
        const { width, height } = image.getSize()
        const bitmap = image.toBitmap()
        const at = ((height >> 1) * width + (width >> 1)) * 4
        return [bitmap[at + 2], bitmap[at + 1], bitmap[at]]
      }, imagePath)
      expect(pixel[0]).toBeGreaterThan(180)
      expect(pixel[2]).toBeLessThan(90)

      await win.getByRole('tab', { name: 'clip.webm' }).click()
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'clip.webm' },
        [],
        [{ keyCode: 'A', modifiers: ['control'] }],
      )
      await expect(bar).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(() =>
          guest<boolean>(app, 'clip.webm', 'document.querySelector(".ostia-media-crop").hidden'),
        )
        .toBe(false)
      expect(await guest<boolean>(app, 'clip.webm', 'document.querySelector("video").paused')).toBe(
        true,
      )
      await bar.getByRole('button', { name: 'Cancel' }).click()
      await expect
        .poll(() =>
          guest<boolean>(app, 'clip.webm', 'document.querySelector(".ostia-media-crop").hidden'),
        )
        .toBe(true)
    })

    await test.step('an audio file over 50 MiB plays and seeks through range reads', async () => {
      await openMedia(win, 'long.wav')
      await expect
        .poll(
          () => guest<number>(app, 'long.wav', 'document.querySelector("video")?.duration ?? 0'),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(LONG_SECONDS - 1)
      expect(
        await guest<number>(
          app,
          'long.wav',
          'document.querySelectorAll(".ostia-media-stage").length',
        ),
      ).toBe(0)
      expect(
        await guest<number>(
          app,
          'long.wav',
          'document.querySelectorAll(".ostia-media-cover").length',
        ),
      ).toBe(1)

      const play = await centerOf(app, 'long.wav', 'Play')
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'long.wav' },
        clickAt(play.x, play.y),
      )
      await expect
        .poll(() => currentTime(app, 'long.wav'), { timeout: 10_000 })
        .toBeGreaterThan(0.3)

      const forward = await centerOf(app, 'long.wav', 'Forward 10 seconds')
      const before = await currentTime(app, 'long.wav')
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'long.wav' },
        clickAt(forward.x, forward.y),
      )
      await expect.poll(() => currentTime(app, 'long.wav')).toBeGreaterThan(before + 9)

      await guest(app, 'long.wav', 'document.querySelector("video").currentTime = 250')
      await expect
        .poll(() => currentTime(app, 'long.wav'), { timeout: 15_000 })
        .toBeGreaterThan(250)
      await guest(app, 'long.wav', 'document.activeElement?.blur?.()')
      await viewerGuestInput(
        app,
        { viewType: VIEW_TYPE, name: 'long.wav' },
        [],
        [{ keyCode: 'Space' }],
      )
      await expect
        .poll(() => guest<boolean>(app, 'long.wav', 'document.querySelector("video").paused'))
        .toBe(true)
    })
  })
})
