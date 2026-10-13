import { Badge } from '@/components/ui/badge'
import { Combobox, ComboboxInput } from '@/components/ui/combobox'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hint } from './Hint'

describe('ui components used as Base UI triggers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('gives a badge ref its span, so a tooltip can anchor to it', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Badge ref={ref}>chip</Badge>)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
    expect(ref.current).toHaveTextContent('chip')
  })

  it('wraps a badge in a hint without dropping its ref', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Hint label="details">
        <Badge>chip</Badge>
      </Hint>,
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('renders a combobox trigger inside the input group without dropping its ref', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Combobox items={['Inter']}>
        <ComboboxInput placeholder="Font" />
      </Combobox>,
    )
    expect(error).not.toHaveBeenCalled()
  })
})
