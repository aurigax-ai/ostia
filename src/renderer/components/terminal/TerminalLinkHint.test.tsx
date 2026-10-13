import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type LinkHintBox, TerminalLinkHint } from './TerminalLinkHint'

vi.mock('@/platform', () => ({ platform: 'darwin', isMac: true, isLinux: false }))

afterEach(cleanup)

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
})
