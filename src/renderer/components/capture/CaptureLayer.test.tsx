import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  type CaptureAdapter,
  closeCapture,
  openCapture,
  setCaptureStatus,
  useCaptureStore,
} from '@/lib/capture/captureSession'
import { CaptureLayer } from './CaptureLayer'

vi.mock('@/lib/agents/useAgentTargets', () => ({
  useAgentTargets: () => [],
  useNoAgentsText: () => 'No agent is running in this workspace.',
}))

afterEach(() => {
  cleanup()
  closeCapture('p1', 'source-gone')
  setCaptureStatus('p1', null)
})

function adapterOf(over: Partial<CaptureAdapter> = {}): CaptureAdapter {
  return {
    anchor: { left: 0, top: 0, bottom: 10 },
    takeFocus: true,
    highlight: null,
    copy: vi.fn().mockResolvedValue({ ok: true, status: 'Copied the selection.' }),
    send: vi.fn().mockResolvedValue({ ok: true, inserted: true }),
    clear: vi.fn(),
    ...over,
  }
}

function view(visible: boolean) {
  return (
    <TooltipProvider>
      <div className="relative">
        <CaptureLayer workspaceId="w1" paneId="p1" visible={visible} />
      </div>
    </TooltipProvider>
  )
}

function setup(over: Partial<CaptureAdapter> = {}) {
  const adapter = adapterOf(over)
  const rendered = render(view(true))
  act(() => openCapture('p1', adapter))
  return { adapter, ...rendered }
}

const bar = () => screen.getByRole('toolbar', { name: /selection actions/i })

describe('CaptureLayer', () => {
  it('closes on Escape, a click elsewhere, a scroll and a plain key, each with its reason', () => {
    const reasons: Array<[() => void, string]> = [
      [() => fireEvent.keyDown(document.body, { key: 'Escape' }), 'escape'],
      [() => fireEvent.pointerDown(document.body), 'outside'],
      [() => fireEvent.scroll(document.body), 'scroll'],
      [() => fireEvent.keyDown(document.body, { key: 'a' }), 'key'],
    ]
    for (const [act_, reason] of reasons) {
      const { adapter, unmount } = setup()
      act(act_)
      expect(adapter.clear).toHaveBeenCalledExactlyOnceWith(reason)
      expect(screen.queryByRole('toolbar')).toBeNull()
      unmount()
    }
  })

  it('stays open for modifier keys, copy chords, typing inside it and the window losing focus', async () => {
    const { adapter } = setup()
    fireEvent.blur(window)
    fireEvent.keyDown(document.body, { key: 'Control', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    fireEvent.pointerDown(within(bar()).getByRole('button', { name: 'Copy' }))
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /add a note/i }), 'abc')
    expect(adapter.clear).not.toHaveBeenCalled()
  })

  it('does not take the focus back from what the user clicked', () => {
    const other = document.createElement('input')
    document.body.append(other)
    setup()
    other.focus()
    fireEvent.pointerDown(other)
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(other).toHaveFocus()
  })

  it('closes when its pane is hidden and when its surface goes away', () => {
    const { adapter, rerender, unmount } = setup()
    rerender(view(false))
    expect(adapter.clear).toHaveBeenCalledExactlyOnceWith('hidden')
    const gone = adapterOf()
    rerender(view(true))
    act(() => openCapture('p1', gone))
    unmount()
    expect(gone.clear).toHaveBeenCalledExactlyOnceWith('source-gone')
    expect(useCaptureStore.getState().open.p1).toBeUndefined()
  })

  it('shows the pane status line over the pane and drops it on its dismiss button', async () => {
    render(view(true))
    act(() => setCaptureStatus('p1', 'Copied the selection.'))
    const line = screen.getByRole('status')
    expect(line.parentElement).toHaveClass('absolute', 'top-0')
    expect(line).toHaveTextContent('Copied the selection.')
    await userEvent.click(within(line).getByRole('button'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  describe('Escape', () => {
    function escapeFrom(target: Element): { prevented: boolean; reached: boolean } {
      let reached = false
      const listener = (): void => {
        reached = true
      }
      window.addEventListener('keydown', listener)
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      act(() => {
        target.dispatchEvent(event)
      })
      window.removeEventListener('keydown', listener)
      return { prevented: event.defaultPrevented, reached }
    }

    it('is swallowed only while the bar itself has the focus', () => {
      const { adapter } = setup()
      expect(escapeFrom(bar())).toEqual({ prevented: true, reached: false })
      expect(adapter.clear).toHaveBeenCalledTimes(1)
    })

    it('reaches what has the focus when the bar does not, and still closes the bar', () => {
      const other = document.createElement('textarea')
      document.body.append(other)
      other.focus()
      const { adapter } = setup({ takeFocus: false })
      expect(escapeFrom(other)).toEqual({ prevented: false, reached: true })
      expect(adapter.clear).toHaveBeenCalledTimes(1)
    })
  })
})
