import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { chordText } from '@shared/keyboard/chordSpec'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
