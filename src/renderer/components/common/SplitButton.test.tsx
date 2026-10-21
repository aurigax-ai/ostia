import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MenuItem } from './Menu'
import { SplitButton, SplitButtonMenu } from './SplitButton'

afterEach(cleanup)

describe('SplitButton', () => {
  it('draws the ghost variant as a bare group with one subtle separator and no group ring', () => {
    const { container } = render(
      <SplitButton label="Agent" variant="ghost" main={<button type="button">main</button>}>
        <SplitButtonMenu label="More" size="2xs" variant="ghost">
          <MenuItem>one</MenuItem>
        </SplitButtonMenu>
      </SplitButton>,
    )
    const group = screen.getByRole('group', { name: 'Agent' })
    expect(group.querySelectorAll('[data-slot=button-group-separator]')).toHaveLength(1)
    expect(container.querySelector('[data-slot=button-group]')).toBeNull()
  })

  it('keeps the separator in the default variant', () => {
    render(
      <SplitButton label="Go" main={<button type="button">main</button>}>
        <SplitButtonMenu label="More" size="sm">
          <MenuItem>one</MenuItem>
        </SplitButtonMenu>
      </SplitButton>,
    )
    const group = screen.getByRole('group', { name: 'Go' })
    expect(group.querySelector('[data-slot=button-group-separator]')).not.toBeNull()
  })

  it('makes the 2xs caret 22 px high and as wide as its 16 px icon, and opens its menu', async () => {
    render(
      <SplitButton label="Agent" variant="ghost" main={<button type="button">main</button>}>
        <SplitButtonMenu label="More" size="2xs" variant="ghost">
          <MenuItem>one</MenuItem>
        </SplitButtonMenu>
      </SplitButton>,
    )
    const caret = screen.getByRole('button', { name: 'More' })
    expect(caret).toHaveClass('size-5.5', 'w-4!')
    await userEvent.setup().click(caret)
    expect(await screen.findByRole('menuitem', { name: 'one' })).toBeInTheDocument()
  })
})
