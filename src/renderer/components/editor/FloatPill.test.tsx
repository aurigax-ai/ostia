import '@testing-library/jest-dom/vitest'
import { PILL_IDLE_MS } from '@aurigax-ai/ostia-extension-sdk/contract/pillIdle'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatPill } from './FloatPill'

function setup(held = false): { pane: HTMLElement; pill: HTMLElement; button: HTMLElement } {
  const view = render(
    <div data-testid="pane">
      <FloatPill label="Tools" held={held}>
        <button type="button">Pick</button>
      </FloatPill>
    </div>,
  )
  return {
    pane: view.getByTestId('pane'),
    pill: screen.getByRole('toolbar', { name: 'Tools' }),
    button: screen.getByRole('button', { name: 'Pick' }),
  }
}

const idle = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(PILL_IDLE_MS + 1)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FloatPill idle', () => {
  it('is visible at first, idles after the idle time and wakes on pointer movement', async () => {
    const { pane, pill } = setup()
    expect(pill).toHaveAttribute('data-state', 'visible')
    await idle()
    expect(pill).toHaveAttribute('data-state', 'idle')
    fireEvent.pointerMove(pane)
    expect(pill).toHaveAttribute('data-state', 'visible')
    await idle()
    expect(pill).toHaveAttribute('data-state', 'idle')
    fireEvent.keyDown(pane, { key: 'a' })
    expect(pill).toHaveAttribute('data-state', 'visible')
  })

  it('stays visible while hovered or focused and keeps its buttons reachable when idle', async () => {
    const { pill, button } = setup()
    await idle()
    expect(button).not.toHaveAttribute('inert')
    expect(button.tabIndex).toBe(0)
    fireEvent.pointerEnter(pill)
    await idle()
    expect(pill).toHaveAttribute('data-state', 'visible')
    fireEvent.pointerLeave(pill)
    expect(pill).toHaveAttribute('data-state', 'idle')
    fireEvent.focus(button)
    expect(pill).toHaveAttribute('data-state', 'visible')
    fireEvent.blur(button)
    expect(pill).toHaveAttribute('data-state', 'idle')
  })

  it('wakes when the page reports activity', async () => {
    const view = render(
      <div>
        <FloatPill label="Tools" activity={0}>
          <button type="button">Pick</button>
        </FloatPill>
      </div>,
    )
    const pill = screen.getByRole('toolbar', { name: 'Tools' })
    await idle()
    expect(pill).toHaveAttribute('data-state', 'idle')
    view.rerender(
      <div>
        <FloatPill label="Tools" activity={1}>
          <button type="button">Pick</button>
        </FloatPill>
      </div>,
    )
    expect(pill).toHaveAttribute('data-state', 'visible')
    await idle()
    expect(pill).toHaveAttribute('data-state', 'idle')
  })

  it('stays visible while a capture tool is held', async () => {
    const { pill } = setup(true)
    await idle()
    expect(pill).toHaveAttribute('data-state', 'visible')
  })
})
