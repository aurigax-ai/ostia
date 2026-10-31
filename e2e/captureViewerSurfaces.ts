import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptureSurface } from './captureMatrix'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { textPdf } from './pdfFixture'
import { pngOf } from './pngFixture'
import { type ElectronApplication, _electron as electron, expect, type Page } from './test'
import { viewerGuestDrag, viewerGuestRun, viewerGuestText } from './viewerGuest'

interface ViewerFixture {
  files: Record<string, Uint8Array | string>
  open: (win: Page) => Promise<void>
}

async function launchViewer(
  fixture: ViewerFixture,
): Promise<{ app: ElectronApplication; win: Page }> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  for (const [name, bytes] of Object.entries(fixture.files)) writeFileSync(join(home, name), bytes)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  const win = await app.firstWindow()
  await openWorkspace(win)
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await fixture.open(win)
  return { app, win }
}

async function openFileViewer(win: Page, name: string, viewType: string): Promise<void> {
  await win.locator('.file-row').filter({ hasText: name }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    viewType,
    { timeout: 15_000 },
  )
}

function clickInViewer(win: Page): () => Promise<void> {
  return async () => {
    const box = await win.locator('webview:visible').boundingBox()
    if (!box) throw new Error('the viewer has no box')
    await win.mouse.click(box.x + box.width - 30, box.y + box.height - 30)
  }
}

const PDF = { viewType: 'pdf.pdf' }

export const pdfViewerSurface: CaptureSurface = {
  name: 'viewer-pdf',
  launch: async () => {
    const { app, win } = await launchViewer({
      files: { 'invoice.pdf': textPdf('Hello needle one', 'Second page with a needle') },
      open: (w) => openFileViewer(w, 'invoice.pdf', 'pdf.pdf'),
    })
    await expect
      .poll(() => viewerGuestRun(app, PDF, 'document.querySelectorAll(".pdf-text span").length'), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0)
    const boxOf = async (selector: string) => {
      const inGuest = (await viewerGuestRun(
        app,
        PDF,
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`,
      )) as { x: number; y: number; width: number; height: number }
      const frame = await win.locator('webview:visible').boundingBox()
      if (!frame) throw new Error('the viewer has no box')
      return { ...inGuest, x: inGuest.x + frame.x, y: inGuest.y + frame.y }
    }
    return {
      app,
      win,
      open: async () => {
        const span = await boxOf('.pdf-text span')
        const y = span.y + span.height / 2
        await win.mouse.move(span.x + 2, y)
        await win.mouse.down()
        await win.mouse.move(span.x + span.width - 2, y, { steps: 6 })
        await win.mouse.up()
      },
      chip: 'Copied',
      copied: /Hello/,
      cleared: async () => {
        await expect.poll(() => viewerGuestRun(app, PDF, 'getSelection().toString()')).toBe('')
      },
      clickGuest: clickInViewer(win),
      close: () => app.close(),
    }
  },
}

const IMAGE = { viewType: 'images.image', name: 'pic.png' }

export const imageViewerSurface: CaptureSurface = {
  name: 'viewer-image',
  launch: async () => {
    const { app, win } = await launchViewer({
      files: { 'pic.png': pngOf(1600, 1000, (x) => (x < 800 ? [255, 0, 0] : [0, 0, 255])) },
      open: (w) => openFileViewer(w, 'pic.png', 'images.image'),
    })
    await expect
      .poll(
        () =>
          viewerGuestRun(app, IMAGE, 'document.querySelector(".canvas img")?.naturalWidth ?? 0'),
        { timeout: 20_000 },
      )
      .toBe(1600)
    return {
      app,
      win,
      open: async () => {
        const box = JSON.parse(
          String(
            await viewerGuestRun(
              app,
              IMAGE,
              'JSON.stringify(document.querySelector(".canvas").getBoundingClientRect())',
            ),
          ),
        ) as { left: number; top: number; width: number; height: number }
        await viewerGuestDrag(
          app,
          IMAGE,
          { x: Math.round(box.left + box.width * 0.4), y: Math.round(box.top + box.height * 0.3) },
          { x: Math.round(box.left + box.width * 0.6), y: Math.round(box.top + box.height * 0.7) },
        )
      },
      chip: 'Copied image',
      copied: 'image',
      cleared: async () => {
        await expect
          .poll(() =>
            viewerGuestRun(
              app,
              IMAGE,
              'document.querySelector(".ostia-pill")?.dataset.state ?? ""',
            ),
          )
          .not.toBe('shown')
      },
      clickGuest: clickInViewer(win),
      close: () => app.close(),
    }
  },
}

const MARKDOWN = { viewType: 'markdown.preview' }

export const markdownViewerSurface: CaptureSurface = {
  name: 'viewer-markdown',
  launch: async () => {
    const { app, win } = await launchViewer({
      files: { 'README.md': '# Report\n\nFirst paragraph here.\n\nSecond paragraph here.\n' },
      open: async (w) => {
        await w.locator('.file-row').filter({ hasText: 'README.md' }).click()
        await expect(w.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
        await w.getByRole('button', { name: 'Open with Preview' }).click()
        await expect(w.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
          'data-view-type',
          'markdown.preview',
          { timeout: 20_000 },
        )
      },
    })
    await expect
      .poll(() => viewerGuestText(app, MARKDOWN), { timeout: 20_000 })
      .toContain('Second paragraph')
    return {
      app,
      win,
      open: async () => {
        const line = (await viewerGuestRun(
          app,
          MARKDOWN,
          `(() => {
            const p = [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Second'))
            const r = p.getBoundingClientRect()
            return { x: Math.round(r.x), y: Math.round(r.y + r.height / 2) }
          })()`,
        )) as { x: number; y: number }
        await viewerGuestDrag(
          app,
          MARKDOWN,
          { x: line.x + 1, y: line.y },
          { x: line.x + 56, y: line.y },
        )
      },
      chip: 'Copied',
      copied: /Second/,
      cleared: async () => {
        await expect.poll(() => viewerGuestRun(app, MARKDOWN, 'getSelection().toString()')).toBe('')
      },
      clickGuest: clickInViewer(win),
      close: () => app.close(),
    }
  },
}
