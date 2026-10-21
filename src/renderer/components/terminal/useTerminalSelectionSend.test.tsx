import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { openSelectionSend } from '@/lib/agents/selectionSenders'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { useTerminalSelectionSend } from './useTerminalSelectionSend'

function Host(): JSX.Element {
  const selectionSend = useTerminalSelectionSend({
    workspaceId: 'w1',
    paneId: 'p1',
    cwd: undefined,
    termRef: { current: { getSelection: () => '' } as unknown as OstiaTerminal },
  })
  return <div data-testid="surface">{selectionSend.status}</div>
}

afterEach(cleanup)

describe('useTerminalSelectionSend', () => {
  it('shows its hint over the terminal, never in the flow that sizes it, and leaves it transient and muted', () => {
    render(<Host />)

    act(() => {
      openSelectionSend('p1')
    })

    const line = screen.getByRole('status')
    expect(line.parentElement).toHaveClass('absolute', 'top-0')
    expect(line.querySelector('svg')).not.toHaveClass('text-attn-fg')
    expect(screen.getByTestId('surface').firstElementChild).toBe(line.parentElement)
  })
})
