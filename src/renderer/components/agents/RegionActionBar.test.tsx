import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { RegionActionBar, type RegionActionBarProps } from './RegionActionBar'

const targets: PickTarget[] = [
  {
    paneId: 'p-claude',
    workspaceId: 'w1',
    workspaceName: 'api',
    title: 'Claude Code · api',
    state: 'working',
    sameWorkspace: true,
  },
  {
    paneId: 'p-codex',
    workspaceId: 'w1',
    workspaceName: 'api',
    title: 'Codex · api',
    state: 'waiting',
    sameWorkspace: true,
  },
]

let available = targets

vi.mock('@/lib/agents/useAgentTargets', () => ({
  useAgentTargets: () => available,
  useNoAgentsText: () => 'No agent is running in this workspace.',
}))

afterEach(() => {
  cleanup()
  available = targets
  vi.useRealTimers()
})

function setup(over: Partial<RegionActionBarProps> = {}) {
  const props: RegionActionBarProps = {
    workspaceId: 'w1',
    anchor: { left: 40, top: 20, bottom: 60 },
    onCopy: vi.fn().mockResolvedValue('Copied the selection.'),
    onSend: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...over,
  }
  render(
    <TooltipProvider>
      <div className="relative">
        <RegionActionBar {...props} />
      </div>
    </TooltipProvider>,
  )
  return props
}

const bar = () => screen.getByRole('toolbar', { name: /selection actions/i })

async function sendTo(index: number) {
  await userEvent.click(within(bar()).getByRole('button', { name: /send to agent/i }))
  await userEvent.click((await screen.findAllByRole('menuitem'))[index])
}

describe('RegionActionBar', () => {
  it('sits under the anchor', () => {
    setup()
    expect(bar()).toHaveStyle({ left: '40px', top: '66px' })
  })

  it('copies, then shows one status line instead of the bar', async () => {
    const props = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    expect(props.onCopy).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Copied the selection.')).toBeVisible()
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes at once when a copy has no status to show', async () => {
    const props = setup({ onCopy: vi.fn().mockResolvedValue(null) })
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the status line after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const props = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    await screen.findByText('Copied the selection.')
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the bar and says why when copying fails', async () => {
    const props = setup({ onCopy: vi.fn().mockRejectedValue(new Error('Could not copy.')) })
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    expect(await screen.findByText('Could not copy.')).toBeVisible()
    expect(bar()).toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('lists the agents with their state dots and sends at once to the one picked', async () => {
    const props = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /send to agent/i }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['Claude Code · api', 'Codex · api'])
    expect(items[0].querySelector('.dot.working')).not.toBeNull()
    expect(items[1].querySelector('.dot.waiting')).not.toBeNull()
    await userEvent.click(items[1])
    expect(props.onSend).toHaveBeenCalledWith(targets[1], '')
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  })

  it('says so in the menu when no agent is running', async () => {
    available = []
    setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /send to agent/i }))
    expect(await screen.findByRole('menuitem')).toHaveTextContent(
      'No agent is running in this workspace.',
    )
  })

  it('keeps the bar and shows the reason when sending fails', async () => {
    const props = setup({ onSend: vi.fn().mockRejectedValue(new Error('Could not send.')) })
    await sendTo(0)
    expect(await screen.findByText('Could not send.')).toBeVisible()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('sends the note with the pick and shows the pencil pressed once there is one', async () => {
    const props = setup()
    const pencil = within(bar()).getByRole('button', { name: /add a note/i })
    expect(pencil).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(pencil)
    await userEvent.type(screen.getByRole('textbox', { name: /add a note/i }), 'Check the sum')
    expect(pencil).toHaveAttribute('aria-pressed', 'true')
    await sendTo(0)
    expect(props.onSend).toHaveBeenCalledWith(targets[0], 'Check the sum')
  })

  it('sends the note to the last-used agent on Ctrl+Enter', async () => {
    const props = setup()
    await sendTo(1)
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(
      screen.getByRole('textbox', { name: /add a note/i }),
      'again{Control>}{Enter}{/Control}',
    )
    await waitFor(() => expect(props.onSend).toHaveBeenLastCalledWith(targets[1], 'again'))
  })

  it('opens the agent menu on Ctrl+Enter when no agent was used yet', async () => {
    available = targets.map((t) => ({ ...t, paneId: `${t.paneId}-fresh` }))
    const props = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(
      screen.getByRole('textbox', { name: /add a note/i }),
      'which one{Control>}{Enter}{/Control}',
    )
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2)
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('closes on its button, Escape, a click elsewhere, a scroll and a plain key', async () => {
    const props = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /cancel/i }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(2)
    fireEvent.pointerDown(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(3)
    fireEvent.scroll(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(4)
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(props.onClose).toHaveBeenCalledTimes(5)
  })

  it('stays open for modifier keys, copy chords, typing inside it and the window losing focus', async () => {
    const props = setup()
    fireEvent.blur(window)
    fireEvent.keyDown(document.body, { key: 'Control', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    fireEvent.pointerDown(within(bar()).getByRole('button', { name: 'Copy' }))
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /add a note/i }), 'abc')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  describe('keyboard focus', () => {
    function origin(): HTMLButtonElement {
      const button = document.createElement('button')
      button.textContent = 'origin'
      document.body.append(button)
      button.focus()
      return button
    }

    it('takes the focus when it opens, so Tab reaches Copy, Send to agent and the note', async () => {
      origin()
      setup()
      expect(bar()).toHaveFocus()
      await userEvent.tab()
      expect(within(bar()).getByRole('button', { name: 'Copy' })).toHaveFocus()
      await userEvent.tab()
      expect(within(bar()).getByRole('button', { name: /send to agent/i })).toHaveFocus()
      await userEvent.tab()
      expect(within(bar()).getByRole('button', { name: /add a note/i })).toHaveFocus()
    })

    it('gives the focus back to where it came from when it closes', async () => {
      const from = origin()
      const Host = (): JSX.Element => {
        const [open, setOpen] = useState(true)
        return open ? (
          <RegionActionBar
            workspaceId="w1"
            anchor={{ left: 0, top: 0, bottom: 10 }}
            onCopy={vi.fn()}
            onSend={vi.fn()}
            onClose={() => setOpen(false)}
          />
        ) : (
          <span>closed</span>
        )
      }
      render(
        <TooltipProvider>
          <div className="relative">
            <Host />
          </div>
        </TooltipProvider>,
      )
      expect(bar()).toHaveFocus()
      fireEvent.keyDown(bar(), { key: 'Escape' })
      expect(await screen.findByText('closed')).toBeInTheDocument()
      expect(from).toHaveFocus()
    })

    it('does not take the focus back from what the user clicked', async () => {
      origin()
      const other = document.createElement('input')
      document.body.append(other)
      const props = setup()
      other.focus()
      fireEvent.pointerDown(other)
      expect(props.onClose).toHaveBeenCalled()
      expect(other).toHaveFocus()
    })

    it('leaves the focus where it is when it was opened without taking it', () => {
      const from = origin()
      setup({ takeFocus: false })
      expect(from).toHaveFocus()
    })
  })

  describe('Escape', () => {
    function escapeFrom(target: Element): { prevented: boolean; reached: boolean } {
      let reached = false
      const listener = (): void => {
        reached = true
      }
      window.addEventListener('keydown', listener)
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      window.removeEventListener('keydown', listener)
      return { prevented: event.defaultPrevented, reached }
    }

    it('is swallowed only while the bar itself has the focus', () => {
      const props = setup()
      expect(escapeFrom(bar())).toEqual({ prevented: true, reached: false })
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('reaches what has the focus when the bar does not, and still closes the bar', () => {
      const other = document.createElement('textarea')
      document.body.append(other)
      other.focus()
      const props = setup({ takeFocus: false })
      expect(escapeFrom(other)).toEqual({ prevented: false, reached: true })
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('send request', () => {
    it('opens the agent menu and takes the focus when asked again, not when it mounts', async () => {
      const props: RegionActionBarProps = {
        workspaceId: 'w1',
        anchor: { left: 0, top: 0, bottom: 10 },
        onCopy: vi.fn(),
        onSend: vi.fn(),
        onClose: vi.fn(),
        takeFocus: false,
        sendRequest: 3,
      }
      const view = (request: number) => (
        <TooltipProvider>
          <div className="relative">
            <RegionActionBar {...props} sendRequest={request} />
          </div>
        </TooltipProvider>
      )
      const { rerender } = render(view(3))
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
      rerender(view(4))
      expect(await screen.findAllByRole('menuitem')).toHaveLength(2)
    })
  })
})
