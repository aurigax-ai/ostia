import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RiskyPasteDialog } from './RiskyPasteDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

afterEach(cleanup)

describe('RiskyPasteDialog', () => {
  it('renders nothing while there is no pending paste', () => {
    render(<RiskyPasteDialog text={null} onPaste={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('previews the text with control characters made visible', () => {
    render(<RiskyPasteDialog text={'echo hi\n\x1b[31m'} onPaste={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Text to paste').textContent).toBe('echo hi\n␛[31m')
  })

  it('pastes the pending text when Paste is pressed', async () => {
    const onPaste = vi.fn()
    const onCancel = vi.fn()
    render(<RiskyPasteDialog text={'a\nb'} onPaste={onPaste} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(onPaste).toHaveBeenCalledWith('a\nb')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels without pasting on Cancel and on Escape', async () => {
    const onPaste = vi.fn()
    const onCancel = vi.fn()
    render(<RiskyPasteDialog text={'a\nb'} onPaste={onPaste} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onPaste).not.toHaveBeenCalled()
  })
})
