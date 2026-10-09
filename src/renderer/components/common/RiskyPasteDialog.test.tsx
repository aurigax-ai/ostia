import '@testing-library/jest-dom/vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RiskyPasteDialog } from './RiskyPasteDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(settingsInit, true)
})

describe('RiskyPasteDialog', () => {
  it('renders nothing while there is no pending paste', () => {
    render(<RiskyPasteDialog text={null} source="human" onPaste={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses most of the window width', () => {
    render(<RiskyPasteDialog text={'a\nb'} source="human" onPaste={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveClass('w-[min(90vw,56rem)]', 'max-w-none')
  })

  it('previews the text with control characters as muted caret tokens', () => {
    render(
      <RiskyPasteDialog
        text={'echo hi\n\x1b[31m'}
        source="human"
        onPaste={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const preview = screen.getByLabelText('Text to paste')
    expect(preview.textContent).toBe('echo hi\n^[[31m')
    const tokens = preview.querySelectorAll('[data-control]')
    expect([...tokens].map((t) => t.textContent)).toEqual(['^['])
    expect(tokens[0]).toHaveClass('text-fg-muted')
  })

  it('says how many lines and characters the text has', () => {
    render(
      <RiskyPasteDialog text={'a\nb\nc\n'} source="human" onPaste={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.getByText('It has 3 lines, so a shell may run them right away.')).toBeVisible()
    expect(screen.getByText('3 lines · 6 characters')).toBeVisible()
  })

  it('names control characters when the text is one line', () => {
    render(
      <RiskyPasteDialog text={'a\x1bb'} source="generated" onPaste={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(
      screen.getByText('It contains control characters, which a shell may act on right away.'),
    ).toBeVisible()
    expect(screen.getByText('3 characters')).toBeVisible()
  })

  it('focuses Paste on open so Enter pastes', async () => {
    const onPaste = vi.fn()
    render(<RiskyPasteDialog text={'a\nb'} source="human" onPaste={onPaste} onCancel={vi.fn()} />)
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Paste' })).toHaveFocus())
    await userEvent.keyboard('{Enter}')
    expect(onPaste).toHaveBeenCalledWith('a\nb')
  })

  it('pastes the pending text when Paste is pressed', async () => {
    const onPaste = vi.fn()
    const onCancel = vi.fn()
    render(<RiskyPasteDialog text={'a\nb'} source="human" onPaste={onPaste} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(onPaste).toHaveBeenCalledWith('a\nb')
    expect(onCancel).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().terminal.warnOnRiskyPaste).toBe(true)
  })

  it('cancels without pasting on Cancel and on Escape', async () => {
    const onPaste = vi.fn()
    const onCancel = vi.fn()
    render(<RiskyPasteDialog text={'a\nb'} source="human" onPaste={onPaste} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onPaste).not.toHaveBeenCalled()
  })

  it('turns confirmation off when Don’t ask again is checked and the human pastes', async () => {
    const onPaste = vi.fn()
    render(<RiskyPasteDialog text={'a\nb'} source="human" onPaste={onPaste} onCancel={vi.fn()} />)
    const dontAsk = screen.getByRole('checkbox', { name: /Don’t ask again/ })
    expect(dontAsk).toHaveAccessibleName(
      'Don’t ask again for multi-line pastes (turn it back on in Settings → Terminal)',
    )
    await userEvent.click(dontAsk)
    expect(useSettingsStore.getState().terminal.warnOnRiskyPaste).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(onPaste).toHaveBeenCalledWith('a\nb')
    expect(useSettingsStore.getState().terminal.warnOnRiskyPaste).toBe(false)
  })

  it('keeps confirmation on when Don’t ask again is checked but the human cancels', async () => {
    render(<RiskyPasteDialog text={'a\nb'} source="human" onPaste={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('checkbox', { name: /Don’t ask again/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useSettingsStore.getState().terminal.warnOnRiskyPaste).toBe(true)
  })

  it('offers no Don’t ask again for text an agent or chat produced', () => {
    render(
      <RiskyPasteDialog text={'a\nb'} source="generated" onPaste={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
