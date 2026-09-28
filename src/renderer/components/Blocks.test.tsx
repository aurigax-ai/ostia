import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StickyHeader } from './Blocks'

const info = { blockId: 'b1', command: 'npm run dev', line: 42 }

describe('StickyHeader', () => {
  it('shows the command with a running label while the command runs', () => {
    render(<StickyHeader info={{ ...info, running: true, exitCode: null }} onJump={vi.fn()} />)

    const header = screen.getByRole('button', { name: /Scroll to command: npm run dev/ })
    expect(header).toHaveTextContent('npm run dev')
    expect(header).toHaveTextContent('Running')
    expect(header).not.toHaveClass('attn')
  })

  it('shows the exit code and marks a failed command', () => {
    render(<StickyHeader info={{ ...info, running: false, exitCode: 2 }} onJump={vi.fn()} />)

    const header = screen.getByRole('button', { name: /npm run dev/ })
    expect(header).toHaveTextContent('exit 2')
    expect(header).toHaveClass('attn')
  })

  it('scrolls to the command line when clicked', async () => {
    const onJump = vi.fn()
    render(<StickyHeader info={{ ...info, running: false, exitCode: 0 }} onJump={onJump} />)

    await userEvent.click(screen.getByRole('button', { name: /npm run dev/ }))

    expect(onJump).toHaveBeenCalledWith(42)
  })
})
