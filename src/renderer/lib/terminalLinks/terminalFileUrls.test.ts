import type { FileUrlTarget } from '@shared/files/fileUrls'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLink as ILink, OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { pathLinkTarget, terminalLinkTarget } from './linkModifier'
import {
  createFileUrlLinks,
  type FileUrlDeps,
  fileUrlAction,
  fileUrlOffers,
  withFileUrls,
} from './terminalFileUrls'

const macTarget = (e: MouseEvent) => pathLinkTarget(e, { mac: true, linkClick: 'app' })

const PAGE = 'file:///Users/j/.cache/meeting-transcribe/results/yushan/speakers.html'
const PAGE_PATH = '/Users/j/.cache/meeting-transcribe/results/yushan/speakers.html'
const INERT = [
  'file:///Users/j/run.command',
  'file:///Users/j/Tool.app',
  'file:///Users/j/bin/tool',
  'file:///Users/j/docs/',
  'file:///etc/hosts',
  'file:///tmp/outside.pdf',
]

function fakeTerminal(text: string): OstiaTerminal {
  const cells = [...text]
  const line = {
    isWrapped: false,
    length: cells.length,
    getCell: (x: number) =>
      cells[x] === undefined ? undefined : { getChars: () => cells[x], getWidth: () => 1 },
  }
  return {
    buffer: { active: { length: 1, getLine: (y: number) => (y === 0 ? line : undefined) } },
  } as unknown as OstiaTerminal
}

const allowed = async (url: string): Promise<FileUrlTarget | null> => {
  if (url === PAGE) return { path: PAGE_PATH, opener: 'html-page' }
  if (url.endsWith('.pdf') && url.startsWith('file:///Users/')) {
    return { path: decodeURIComponent(url.slice('file://'.length)), opener: 'default-app' }
  }
  return null
}

function fileUrls(more: Partial<FileUrlDeps> = {}) {
  const deps = {
    remote: () => false,
    check: vi.fn(allowed),
    previews: () => false,
    target: macTarget,
    activate: vi.fn(),
    hover: vi.fn(),
    leave: vi.fn(),
    ...more,
  }
  return { deps, links: createFileUrlLinks(deps) }
}

function linksFor(text: string, more: Partial<FileUrlDeps> = {}) {
  const made = fileUrls(more)
  const provider = made.links.provider(fakeTerminal(text))
  return new Promise<typeof made & { found: ILink[] | undefined }>((resolve) =>
    provider.provideLinks(1, (found) => resolve({ ...made, found })),
  )
}

const human = (init: Partial<MouseEvent> = {}) =>
  ({
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isTrusted: true,
    ...init,
  }) as MouseEvent

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createFileUrlLinks provider', () => {
  it('links the example speakers.html and opens it on a human Cmd+click', async () => {
    const text = `review ${PAGE} now`
    const { found, deps } = await linksFor(text)
    expect(found).toHaveLength(1)
    const [link] = found ?? []
    expect(link.text).toBe(PAGE)
    expect(link.range).toEqual({ start: { x: 8, y: 1 }, end: { x: 7 + PAGE.length, y: 1 } })
    link.activate(human(), link.text)
    await settle()
    expect(deps.activate).toHaveBeenCalledWith(
      'open',
      PAGE,
      { path: PAGE_PATH, opener: 'html-page' },
      'browse-page',
    )
  })

  it('opens a pdf and a png through main on Cmd+click', async () => {
    const pdf = 'file:///Users/j/a%20b.pdf'
    const png = 'file:///Users/j/shot.png'
    const check = vi.fn(
      async (url: string): Promise<FileUrlTarget | null> =>
        url === png ? { path: '/Users/j/shot.png', opener: 'default-app' } : allowed(url),
    )
    const { found, deps } = await linksFor(`${pdf} ${png}`, { check })
    expect(found?.map((l) => l.text)).toEqual([pdf, png])
    for (const link of found ?? []) link.activate(human(), link.text)
    await settle()
    expect(deps.activate).toHaveBeenCalledWith(
      'open',
      pdf,
      { path: '/Users/j/a b.pdf', opener: 'default-app' },
      'open-default',
    )
    expect(deps.activate).toHaveBeenCalledWith(
      'open',
      png,
      { path: '/Users/j/shot.png', opener: 'default-app' },
      'open-default',
    )
  })

  it('leaves commands, apps, executables, folders and files outside home unlinked', async () => {
    const check = vi.fn(allowed)
    const { found } = await linksFor(INERT.join(' '), { check })
    expect(found).toBeUndefined()
    expect(check.mock.calls).toEqual([['file:///tmp/outside.pdf']])
  })

  it('asks main about a hostname url, linking the local hostname and not another machine', async () => {
    const local = 'file://Mac/Users/j/listing.pdf'
    const other = 'file://other-mac/Users/j/listing.pdf'
    const check = vi.fn(
      async (url: string): Promise<FileUrlTarget | null> =>
        url === local ? { path: '/Users/j/listing.pdf', opener: 'default-app' } : null,
    )
    const { found, deps } = await linksFor(`${local} ${other}`, { check })
    expect(check.mock.calls).toEqual([[local], [other]])
    expect(found?.map((l) => l.text)).toEqual([local])
    for (const link of found ?? []) link.activate(human(), link.text)
    await settle()
    expect(deps.activate).toHaveBeenCalledTimes(1)
    expect(deps.activate).toHaveBeenCalledWith(
      'open',
      local,
      { path: '/Users/j/listing.pdf', opener: 'default-app' },
      'open-default',
    )
  })

  it('does nothing without the modifier, for a scripted click or in a remote shell', async () => {
    const { found, deps } = await linksFor(PAGE)
    const [link] = found ?? []
    link.activate(human({ metaKey: false }), link.text)
    link.activate(human({ isTrusted: false }), link.text)
    await settle()
    expect(deps.activate).not.toHaveBeenCalled()
    const remote = await linksFor(PAGE, { remote: () => true })
    expect(remote.found).toBeUndefined()
    expect(remote.deps.check).not.toHaveBeenCalled()
  })

  it('opens a previewable page with the system browser on Cmd+Shift+click, and other files only with Cmd', async () => {
    const pdf = 'file:///Users/j/a.pdf'
    const previews = (target: FileUrlTarget) => target.opener === 'html-page'
    const { found, deps } = await linksFor(`${PAGE} ${pdf}`, { previews })
    const [page, doc] = found ?? []
    page.activate(human({ shiftKey: true }), page.text)
    doc.activate(human({ shiftKey: true }), doc.text)
    doc.activate(human({ altKey: true }), doc.text)
    await settle()
    expect(deps.activate).toHaveBeenCalledTimes(1)
    expect(deps.activate).toHaveBeenCalledWith(
      'open-system',
      PAGE,
      { path: PAGE_PATH, opener: 'html-page' },
      'preview-page',
    )
  })

  it('offers a page outside the artifacts folder only with Cmd, since both clicks would open the browser', async () => {
    const { found, deps } = await linksFor(PAGE)
    const [page] = found ?? []
    page.activate(human({ shiftKey: true }), page.text)
    await settle()
    expect(deps.activate).not.toHaveBeenCalled()
    page.hover?.(new MouseEvent('mousemove'), page.text)
    await settle()
    expect(deps.hover).toHaveBeenCalledWith(
      page.range,
      { path: PAGE_PATH, opener: 'html-page' },
      'browse-page',
    )
  })

  it('hovers with the decoded real path and stops once the pointer left', async () => {
    const { found, deps } = await linksFor(PAGE)
    const [link] = found ?? []
    link.hover?.(new MouseEvent('mousemove'), link.text)
    await settle()
    expect(deps.hover).toHaveBeenCalledWith(
      link.range,
      { path: PAGE_PATH, opener: 'html-page' },
      'browse-page',
    )
    link.leave?.(new MouseEvent('mousemove'), link.text)
    expect(deps.leave).toHaveBeenCalledTimes(1)
  })

  it('asks main once per url within five seconds', async () => {
    const made = fileUrls()
    const term = fakeTerminal(PAGE)
    const provider = made.links.provider(term)
    await new Promise((resolve) => provider.provideLinks(1, resolve))
    await new Promise((resolve) => provider.provideLinks(1, resolve))
    expect(made.deps.check).toHaveBeenCalledTimes(1)
  })
})

describe('withFileUrls', () => {
  const range = { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }

  it('sends file urls from OSC 8 hyperlinks to the file url checks and the rest unchanged', async () => {
    const web = { activate: vi.fn(), hover: vi.fn(), leave: vi.fn() }
    const { links, deps } = fileUrls()
    const handler = withFileUrls(web, links)
    handler.hover(new MouseEvent('mousemove'), PAGE, range)
    await settle()
    expect(deps.hover).toHaveBeenCalledWith(
      range,
      { path: PAGE_PATH, opener: 'html-page' },
      'browse-page',
    )
    handler.activate(human(), PAGE, range)
    await settle()
    expect(deps.activate).toHaveBeenCalledWith(
      'open',
      PAGE,
      { path: PAGE_PATH, opener: 'html-page' },
      'browse-page',
    )
    handler.leave(new MouseEvent('mousemove'), PAGE, range)
    expect(deps.leave).toHaveBeenCalledTimes(1)
    expect(web.activate).not.toHaveBeenCalled()
    expect(web.hover).not.toHaveBeenCalled()

    handler.activate(human(), 'https://a.b', range)
    handler.hover(new MouseEvent('mousemove'), 'https://a.b', range)
    expect(web.activate).toHaveBeenCalledWith(expect.anything(), 'https://a.b', range)
    expect(web.hover).toHaveBeenCalledWith(expect.anything(), 'https://a.b', range)
  })

  it('keeps an inert OSC 8 file url inert and never hands it to the web handler', async () => {
    const web = { activate: vi.fn(), hover: vi.fn(), leave: vi.fn() }
    const { links, deps } = fileUrls()
    const handler = withFileUrls(web, links)
    for (const url of INERT) {
      handler.hover(new MouseEvent('mousemove'), url, range)
      handler.activate(human(), url, range)
    }
    await settle()
    expect(deps.activate).not.toHaveBeenCalled()
    expect(deps.hover).not.toHaveBeenCalled()
    expect(web.activate).not.toHaveBeenCalled()
  })

  it('drops a hover answer that arrives after the pointer left', async () => {
    let answer: (target: FileUrlTarget | null) => void = () => {}
    const check = vi.fn(
      () =>
        new Promise<FileUrlTarget | null>((resolve) => {
          answer = resolve
        }),
    )
    const { links, deps } = fileUrls({ check })
    links.hover(range, PAGE)
    links.leave()
    answer({ path: PAGE_PATH, opener: 'html-page' })
    await settle()
    expect(deps.hover).not.toHaveBeenCalled()
  })
})

describe('file url offers', () => {
  it('previews html only where Ostia can show it, and otherwise browses it like any default-app file', () => {
    const page = { path: PAGE_PATH, opener: 'html-page' as const }
    const pdf = { path: '/Users/j/a.pdf', opener: 'default-app' as const }
    expect(fileUrlAction(page, true)).toBe('preview-page')
    expect(fileUrlAction(page, false)).toBe('browse-page')
    expect(fileUrlAction(pdf, true)).toBe('open-default')
    expect(fileUrlOffers('preview-page')).toEqual(['open', 'open-system'])
    expect(fileUrlOffers('browse-page')).toEqual(['open'])
    expect(fileUrlOffers('open-default')).toEqual(['open'])
  })

  it('keeps file urls out of the web and app link targets', () => {
    const ctx = { mac: true, hasSelection: false, mouseReporting: false, linkClick: 'app' as const }
    const click = { ctrlKey: false, metaKey: true, shiftKey: false, detail: 1 }
    expect(terminalLinkTarget(PAGE, click, ctx)).toBeNull()
  })
})
