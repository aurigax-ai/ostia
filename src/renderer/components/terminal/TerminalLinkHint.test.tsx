import '@testing-library/jest-dom/vitest'
import { chordText } from '@shared/keyboard/chordSpec'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LinkHintBox, TerminalLinkHint } from './TerminalLinkHint'

vi.mock('@/platform', () => ({ platform: 'darwin', isMac: true, isLinux: false }))

const initialSettings = useSettingsStore.getState()

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettings, true)
})

const click = chordText({ ctrl: false, meta: true, shift: false, alt: false, key: 'Click' }, true)
const shiftClick = chordText(
  { ctrl: false, meta: true, shift: true, alt: false, key: 'Click' },
  true,
)

const optionClick = chordText(
  { ctrl: false, meta: true, shift: false, alt: true, key: 'Click' },
  true,
)
const optionShiftClick = chordText(
  { ctrl: false, meta: true, shift: true, alt: true, key: 'Click' },
  true,
)

const choices = (): string[] =>
  [...document.querySelectorAll('span.font-medium')].map(
    (el) => el.parentElement?.textContent ?? '',
  )

const box = { left: 0, top: 0, width: 40, height: 16 }

function show(hint: LinkHintBox) {
  render(
    <TooltipProvider>
      <TerminalLinkHint hint={hint} />
    </TooltipProvider>,
  )
}

describe('TerminalLinkHint', () => {
  it('shows the full target of an app link and that a click opens its app', async () => {
    const url = 'obsidian://new?vault=Notes&file=a&content=x&append=true'
    show({ ...box, kind: 'web', url, plainClick: true })
    expect(await screen.findByText(url)).toBeInTheDocument()
    expect(screen.getByText('Open in its app')).toBeInTheDocument()
    expect(screen.queryByText('Open in the browser pane')).toBeNull()
  })

  it('shows the full target of a web link above the browser choices', async () => {
    const url = 'https://example.com/a/very/long/path?q=1'
    show({ ...box, kind: 'web', url, plainClick: true })
    expect(await screen.findByText(url)).toBeInTheDocument()
    expect(screen.getByText('Open in the browser pane')).toBeInTheDocument()
  })

  it('names what each modifier click opens, following the link click setting', async () => {
    const url = 'https://example.com'
    show({ ...box, kind: 'web', url, plainClick: false })
    expect(await screen.findByText(url)).toBeInTheDocument()
    expect(choices()).toEqual([
      `${click} Open in a new browser tab`,
      `${shiftClick} Open in the system browser`,
    ])
    cleanup()

    useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, linkClick: 'system' } }))
    show({ ...box, kind: 'web', url, plainClick: false })
    expect(await screen.findByText(url)).toBeInTheDocument()
    expect(choices()).toEqual([
      `${click} Open in the system browser`,
      `${shiftClick} Open in a new browser tab`,
    ])
  })

  it('lists every action a file link offers with its macOS chord, and swaps Shift with the setting', async () => {
    const offers = ['open', 'open-system', 'show', 'show-system'] as const
    show({ ...box, kind: 'open-file', offers: [...offers], plainClick: true })
    expect(await screen.findByText('Open the file')).toBeInTheDocument()
    expect(choices()).toEqual([
      `${click} Open the file`,
      `${shiftClick} Open with its default app`,
      `${optionClick} Show in Files`,
      `${optionShiftClick} Show in the file manager`,
    ])
    cleanup()

    useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, linkClick: 'system' } }))
    show({ ...box, kind: 'open-file', offers: [...offers], plainClick: true })
    expect(await screen.findByText('Open the file')).toBeInTheDocument()
    expect(choices()).toEqual([
      `${click} Open with its default app`,
      `${shiftClick} Open the file`,
      `${optionClick} Show in the file manager`,
      `${optionShiftClick} Show in Files`,
    ])
  })

  it('lists only what the link offers, and names a folder the file manager opens', async () => {
    show({ ...box, kind: 'open-folder', offers: ['open', 'show-system'], plainClick: true })
    expect(await screen.findByText('Open the folder in the file manager')).toBeInTheDocument()
    expect(choices()).toEqual([
      `${click} Open the folder in the file manager`,
      `${optionShiftClick} Show in the file manager`,
    ])
    cleanup()

    show({ ...box, kind: 'open-file', offers: ['open'], plainClick: true })
    expect(await screen.findByText('Open the file')).toBeInTheDocument()
    expect(choices()).toEqual([`${click} Open the file`])
  })

  it('shows the full decoded path of a local file url and what Cmd opens it with', async () => {
    const path = '/Users/j/.cache/meeting-transcribe/results/會議 記錄/speakers.html'
    show({
      ...box,
      kind: 'preview-page',
      url: path,
      offers: ['open', 'open-system'],
      plainClick: true,
    })
    expect(await screen.findByText(path)).toBeInTheDocument()
    expect(choices()).toEqual([
      `${click} Open the file`,
      `${shiftClick} Open in the system browser`,
    ])
    cleanup()

    const pdf = '/Users/j/Documents/a b.pdf'
    show({ ...box, kind: 'open-default', url: pdf, offers: ['open'], plainClick: true })
    expect(await screen.findByText(pdf)).toBeInTheDocument()
    expect(choices()).toEqual([`${click} Open with its default app`])
  })

  it('lists one system browser row for a page outside the artifacts folder', async () => {
    const path = '/Users/j/.cache/r/speakers.html'
    show({ ...box, kind: 'browse-page', url: path, offers: ['open'], plainClick: true })
    expect(await screen.findByText(path)).toBeInTheDocument()
    expect(choices()).toEqual([`${click} Open in the system browser`])
  })
})
