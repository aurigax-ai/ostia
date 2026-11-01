import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CommitInput, NumberInput } from './CommitInput'

describe('CommitInput', () => {
  it('does not commit while typing, commits on blur', () => {
    const onCommit = vi.fn()
    render(<CommitInput aria-label="t" value="a" onCommit={onCommit} />)
    const input = screen.getByLabelText('t')
    fireEvent.change(input, { target: { value: 'ab' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('ab')
  })

  it('commits on Enter', () => {
    const onCommit = vi.fn()
    render(<CommitInput aria-label="t" value="a" onCommit={onCommit} />)
    const input = screen.getByLabelText('t')
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('ab')
  })

  it('Escape restores the saved value and commits nothing', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<CommitInput aria-label="t" value="a" onCommit={onCommit} onCancel={onCancel} />)
    const input = screen.getByLabelText<HTMLInputElement>('t')
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('a')
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('keeps the draft when the commit is rejected', () => {
    render(<CommitInput aria-label="t" value="a" onCommit={() => false} />)
    const input = screen.getByLabelText<HTMLInputElement>('t')
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.blur(input)
    expect(input.value).toBe('bad')
  })
})

function Validated({ onCancel }: { onCancel: () => void }): JSX.Element {
  const [saved, setSaved] = useState('ok')
  const [bad, setBad] = useState(false)
  return (
    <>
      <CommitInput
        aria-label="t"
        value={saved}
        aria-invalid={bad}
        onCommit={(text) => {
          setBad(text === 'bad')
          if (text !== 'bad') setSaved(text)
          return text !== 'bad'
        }}
        onCancel={() => {
          setBad(false)
          onCancel()
        }}
      />
      <button type="button" onClick={() => setSaved('preset')}>
        preset
      </button>
    </>
  )
}

describe('CommitInput errors and focus', () => {
  it('clears the error when the saved value is retyped', () => {
    const onCancel = vi.fn()
    render(<Validated onCancel={onCancel} />)
    const input = screen.getByLabelText<HTMLInputElement>('t')
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.blur(input)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: 'ok' } })
    fireEvent.blur(input)
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('keeps focus on the same input after Enter commits a new value', () => {
    render(<Validated onCancel={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>('t')
    input.focus()
    fireEvent.change(input, { target: { value: 'next' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByLabelText('t')).toBe(input)
    expect(input).toHaveFocus()
    expect(input.value).toBe('next')
  })

  it('drops a draft when the saved value changes elsewhere', () => {
    render(<Validated onCancel={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>('t')
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'preset' }))
    expect(input.value).toBe('preset')
  })
})

describe('NumberInput', () => {
  it('commits a clamped number on blur and Enter', () => {
    const onCommit = vi.fn()
    render(<NumberInput aria-label="n" value={5} min={1} max={10} onCommit={onCommit} />)
    const input = screen.getByLabelText('n')
    fireEvent.change(input, { target: { value: '99' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenLastCalledWith(10)
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith(3)
  })

  it('reverts an empty entry and Escape restores the saved value', () => {
    const onCommit = vi.fn()
    render(<NumberInput aria-label="n" value={5} onCommit={onCommit} />)
    const input = screen.getByLabelText<HTMLInputElement>('n')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('5')
    fireEvent.change(input, { target: { value: '8' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('5')
    expect(onCommit).not.toHaveBeenCalled()
  })
})
