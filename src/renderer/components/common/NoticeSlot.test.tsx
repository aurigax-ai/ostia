import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { NoticeSlot } from './NoticeSlot'

afterEach(cleanup)

function Host({ on }: { on: boolean }): JSX.Element {
  return (
    <NoticeSlot>
      {on ? (
        <section aria-label="note" className="motion-enter">
          note
        </section>
      ) : null}
    </NoticeSlot>
  )
}

describe('NoticeSlot', () => {
  it('renders nothing while there is no notice', () => {
    const { container } = render(<Host on={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps the last notice inert and hidden from assistive tech until its exit animation ends', () => {
    const { container, rerender } = render(<Host on />)
    const slot = container.querySelector('.notice-slot') as HTMLElement
    expect(slot).not.toHaveAttribute('data-leaving')

    rerender(<Host on={false} />)
    expect(slot).toHaveAttribute('data-leaving')
    expect(slot).toHaveAttribute('aria-hidden', 'true')
    expect(slot.inert).toBe(true)
    expect(screen.queryByRole('region', { name: 'note' })).toBeNull()

    fireEvent.animationEnd(slot, { animationName: 'overlay-in' })
    expect(container.querySelector('.notice-slot')).not.toBeNull()

    fireEvent.animationEnd(slot, { animationName: 'overlay-out' })
    expect(container.innerHTML).toBe('')
  })

  it('removes the notice when its exit animation is cancelled', () => {
    const { container, rerender } = render(<Host on />)
    rerender(<Host on={false} />)
    act(() => {
      container.querySelector('.notice-slot')?.dispatchEvent(new Event('animationcancel'))
    })
    expect(container.innerHTML).toBe('')
  })

  it('shows a notice that returns mid-exit straight away, interactive again', () => {
    const { container, rerender } = render(<Host on />)
    rerender(<Host on={false} />)
    rerender(<Host on />)
    const slot = container.querySelector('.notice-slot') as HTMLElement
    expect(slot).not.toHaveAttribute('data-leaving')
    expect(slot.inert).toBe(false)
    expect(screen.getByRole('region', { name: 'note' })).toBeInTheDocument()
  })
})
