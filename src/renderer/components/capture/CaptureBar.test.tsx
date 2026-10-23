import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PickTarget } from '@/lib/agents/pickTargets'
import {
  type CaptureAdapter,
  closeCapture,
  openCapture,
  useCaptureStore,
} from '@/lib/capture/captureSession'
import { CaptureLayer } from './CaptureLayer'

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
  closeCapture('p1', 'source-gone')
  available = targets
})

function adapterOf(over: Partial<CaptureAdapter> = {}): CaptureAdapter {
  return {
    anchor: { left: 40, top: 20, bottom: 60 },
    takeFocus: true,
    highlight: null,
    copy: vi.fn().mockResolvedValue({ ok: true, status: 'Copied the selection.' }),
    send: vi.fn().mockResolvedValue({ ok: true, inserted: true }),
    clear: vi.fn(),
    ...over,
  }
}

function setup(over: Partial<CaptureAdapter> = {}) {
  const adapter = adapterOf(over)
  render(
    <TooltipProvider>
      <div className="relative">
        <CaptureLayer workspaceId="w1" paneId="p1" />
      </div>
    </TooltipProvider>,
  )
  act(() => openCapture('p1', adapter))
  return adapter
}

const bar = () => screen.getByRole('toolbar', { name: /selection actions/i })

async function sendTo(index: number) {
  await userEvent.click(within(bar()).getByRole('button', { name: /send to agent/i }))
  await userEvent.click((await screen.findAllByRole('menuitem'))[index])
}

describe('CaptureBar', () => {
  it('sits under the anchor', () => {
    setup()
    expect(bar()).toHaveStyle({ left: '40px', top: '66px' })
  })

  it('sits at the corner when the surface has no anchor', () => {
    setup({ anchor: null })
    expect(bar()).toHaveStyle({ left: '12px', top: '18px' })
  })

  it('copies, closes the bar and shows the status line', async () => {
    const adapter = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    expect(adapter.copy).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Copied the selection.')).toBeVisible()
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(adapter.clear).toHaveBeenCalledExactlyOnceWith('copied')
  })

  it('keeps the bar and says why when copying fails', async () => {
    const adapter = setup({
      copy: vi.fn().mockResolvedValue({ ok: false, error: 'Could not copy.' }),
    })
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    expect(await screen.findByText('Could not copy.')).toBeVisible()
    expect(bar()).toBeInTheDocument()
    expect(adapter.clear).not.toHaveBeenCalled()
  })

  it('lists the agents with their state dots and sends at once to the one picked', async () => {
    const adapter = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /send to agent/i }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['Claude Code · api', 'Codex · api'])
    expect(items[0].querySelector('.dot.working')).not.toBeNull()
    expect(items[1].querySelector('.dot.waiting')).not.toBeNull()
    await userEvent.click(items[1])
    expect(adapter.send).toHaveBeenCalledWith(targets[1], '')
    await waitFor(() => expect(adapter.clear).toHaveBeenCalledExactlyOnceWith('sent'))
    expect(await screen.findByText(/Codex · api/)).toBeVisible()
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
    const adapter = setup({
      send: vi.fn().mockResolvedValue({ ok: false, error: 'write-failed' }),
    })
    await sendTo(0)
    expect(await screen.findByText(/write-failed/)).toBeVisible()
    expect(adapter.clear).not.toHaveBeenCalled()
  })

  it('sends the note with the capture and shows the pencil pressed once there is one', async () => {
    const adapter = setup()
    const pencil = within(bar()).getByRole('button', { name: /add a note/i })
    expect(pencil).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(pencil)
    await userEvent.type(screen.getByRole('textbox', { name: /add a note/i }), 'Check the sum')
    expect(pencil).toHaveAttribute('aria-pressed', 'true')
    await sendTo(0)
    expect(adapter.send).toHaveBeenCalledWith(targets[0], 'Check the sum')
  })

  it('sends the note to the last-used agent on Ctrl+Enter', async () => {
    const adapter = setup()
    await sendTo(1)
    await waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1))
    const again = adapterOf()
    act(() => openCapture('p1', again))
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(
      screen.getByRole('textbox', { name: /add a note/i }),
      'again{Control>}{Enter}{/Control}',
    )
    await waitFor(() => expect(again.send).toHaveBeenLastCalledWith(targets[1], 'again'))
  })

  it('opens the agent menu on Ctrl+Enter when no agent was used yet', async () => {
    available = targets.map((t) => ({ ...t, paneId: `${t.paneId}-fresh` }))
    const adapter = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(
      screen.getByRole('textbox', { name: /add a note/i }),
      'which one{Control>}{Enter}{/Control}',
    )
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2)
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('closes on its button', async () => {
    const adapter = setup()
    await userEvent.click(within(bar()).getByRole('button', { name: /cancel/i }))
    expect(adapter.clear).toHaveBeenCalledExactlyOnceWith('cancel')
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('opens the agent menu and takes the focus when asked again, not when it opens', async () => {
    setup({ takeFocus: false })
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    act(
      () =>
        useCaptureStore.getState().open.p1 &&
        useCaptureStore.setState((s) => ({
          open: { ...s.open, p1: { ...s.open.p1, sendRequest: s.open.p1.sendRequest + 1 } },
        })),
    )
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2)
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
      setup()
      expect(bar()).toHaveFocus()
      act(() => closeCapture('p1', 'escape'))
      expect(screen.queryByRole('toolbar')).toBeNull()
      expect(from).toHaveFocus()
    })

    it('leaves the focus where it is when it was opened without taking it', () => {
      const from = origin()
      setup({ takeFocus: false })
      expect(from).toHaveFocus()
    })
  })
})
