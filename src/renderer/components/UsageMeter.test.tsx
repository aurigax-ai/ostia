import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UsageMeter } from './UsageMeter'

/**
 * UsageMeter is a purely presentational, props-driven segmented budget meter. It renders
 * `total` positional cells and marks the first `filled` of them "on", shows the label, an
 * optional value string, and a `title` tooltip of "{label}: {value ?? filled/total}". It
 * carries no ARIA roles, so these tests assert the REAL rendered DOM: label/value text, the
 * title (its only accessible summary), the cell counts, and the tone class on the track.
 *
 * No mocking needed — the component pulls in no stores, no Monaco/xterm/allotment, and makes
 * no `window.pine` bridge calls. Cleanup is handled by the global afterEach in test/setup.ts.
 */

const cells = (root: HTMLElement): NodeListOf<Element> => root.querySelectorAll('.cell')
const onCells = (root: HTMLElement): NodeListOf<Element> => root.querySelectorAll('.cell.on')

describe('UsageMeter', () => {
  it('renders the label, value, and a title summarising "{label}: {value}"', () => {
    const { container } = render(<UsageMeter label="Context" filled={3} total={8} value="30%" />)

    expect(screen.getByText('Context')).toHaveClass('meter-label')
    expect(screen.getByText('30%')).toHaveClass('meter-value')
    // The title is the meter's only accessible summary (no ARIA roles on this element).
    expect(screen.getByTitle('Context: 30%')).toBeInTheDocument()
    expect(cells(container)).toHaveLength(8)
    expect(onCells(container)).toHaveLength(3)
  })

  it('fills the first `filled` cells in order and leaves the rest off', () => {
    const { container } = render(<UsageMeter label="Week" filled={2} total={5} />)

    const all = Array.from(cells(container))
    expect(all).toHaveLength(5)
    expect(all.slice(0, 2).every((c) => c.classList.contains('on'))).toBe(true)
    expect(all.slice(2).some((c) => c.classList.contains('on'))).toBe(false)
  })

  it('falls back to "filled/total" in the title and omits the value span when no value is given', () => {
    const { container } = render(<UsageMeter label="Week" filled={2} total={5} />)

    expect(screen.getByTitle('Week: 2/5')).toBeInTheDocument()
    expect(container.querySelector('.meter-value')).toBeNull()
  })

  it('marks no cells on at 0% and every cell on when full', () => {
    const { container: empty } = render(<UsageMeter label="Empty" filled={0} total={4} />)
    expect(cells(empty)).toHaveLength(4)
    expect(onCells(empty)).toHaveLength(0)

    const { container: full } = render(<UsageMeter label="Full" filled={4} total={4} />)
    expect(cells(full)).toHaveLength(4)
    expect(onCells(full)).toHaveLength(4)
  })

  it('saturates without overflow when `filled` exceeds `total`', () => {
    // Array.from({ length: total }) only ever yields `total` cells; `i < filled` is then
    // true for every one — so an over-budget count fills the track fully, no extra nodes.
    const { container } = render(<UsageMeter label="Over" filled={6} total={4} />)

    expect(cells(container)).toHaveLength(4)
    expect(onCells(container)).toHaveLength(4)
  })

  it('applies the default `accent` tone, and a supplied tone, to the track', () => {
    const { container: def } = render(<UsageMeter label="A" filled={1} total={2} />)
    expect(def.querySelector('.meter-track')).toHaveClass('accent')

    const { container: attn } = render(<UsageMeter label="B" filled={1} total={2} tone="attn" />)
    expect(attn.querySelector('.meter-track')).toHaveClass('attn')
    expect(attn.querySelector('.meter-track')).not.toHaveClass('accent')
  })
})
