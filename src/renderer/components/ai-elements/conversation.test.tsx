import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const scrollToBottom = vi.hoisted(() => vi.fn())

vi.mock('use-stick-to-bottom', () => ({
  StickToBottom: () => null,
  useStickToBottomContext: () => ({ isAtBottom: false, scrollToBottom }),
}))

const { ConversationScrollButton } = await import('./conversation')

describe('ConversationScrollButton', () => {
  it('jumps to the latest message without a spring scroll', async () => {
    render(<ConversationScrollButton label="Scroll to latest" />)
    await userEvent.click(screen.getByRole('button', { name: 'Scroll to latest' }))
    expect(scrollToBottom).toHaveBeenCalledWith('instant')
  })
})
