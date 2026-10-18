import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChordButton } from './ChordButton'

vi.mock('@/lib/keyboard/chords', () => ({
  useChordLabel: (id: string) => (id === 'tab.new' ? 'Ctrl+T' : null),
}))

afterEach(cleanup)

describe('ChordButton', () => {
  it('shows its label with the chord of its command and runs on click', async () => {
    const onClick = vi.fn()
    render(<ChordButton command="tab.new" icon={<i />} label="New terminal" onClick={onClick} />)
    const button = screen.getByRole('button', { name: /New terminal/ })
    expect(button).toHaveTextContent('Ctrl+T')
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows no key cap for a command without a chord', () => {
    render(
      <ChordButton
        command="tab.none"
        variant="outline"
        icon={<i />}
        label="Open"
        onClick={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Open' })).toHaveTextContent(/^Open$/)
  })
})
