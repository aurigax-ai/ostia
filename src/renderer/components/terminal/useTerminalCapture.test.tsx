import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureLayer } from '@/components/capture/CaptureLayer'
import {
  closeCapture,
  setCaptureStatus,
  triggerCapture,
  useCaptureStore,
} from '@/lib/capture/captureSession'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { useTerminalCapture } from './useTerminalCapture'

vi.mock('@/lib/agents/useAgentTargets', () => ({
  useAgentTargets: () => [],
  useNoAgentsText: () => 'No agent is running in this workspace.',
}))

function Host({ selected }: { selected: string }): JSX.Element {
  useTerminalCapture({
    paneId: 'p1',
    cwd: '/work',
    termRef: {
      current: {
        getSelection: () => selected,
        getSelectionPosition: () => undefined,
      } as unknown as OstiaTerminal,
    },
    surfaceRef: { current: null },
  })
  return (
    <div data-testid="surface" className="relative">
      <CaptureLayer workspaceId="w1" paneId="p1" />
    </div>
  )
}

afterEach(() => {
  cleanup()
  closeCapture('p1', 'source-gone')
  setCaptureStatus('p1', null)
})

describe('useTerminalCapture', () => {
  it('shows its hint over the terminal, never in the flow that sizes it, and leaves it transient and muted', () => {
    render(<Host selected="" />)

    act(() => {
      triggerCapture('p1')
    })

    const line = screen.getByRole('status')
    expect(line.parentElement).toHaveClass('absolute', 'top-0')
    expect(line.querySelector('svg')).not.toHaveClass('text-attn-fg')
    expect(screen.getByTestId('surface').firstElementChild?.firstElementChild).toBe(
      line.parentElement,
    )
  })

  it('opens a terminal capture of the selected text with the pane folder', () => {
    render(<Host selected="ls -la" />)
    act(() => {
      triggerCapture('p1')
    })
    expect(useCaptureStore.getState().open.p1).toBeDefined()
    expect(screen.getByRole('toolbar', { name: /selection actions/i })).toBeInTheDocument()
  })
})
