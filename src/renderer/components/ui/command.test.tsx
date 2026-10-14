import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { backgroundTokenOf, themesWhereSame } from '../../../../test/themeColours'
import { Command, CommandInput, CommandItem, CommandList } from './command'

describe('CommandItem', () => {
  afterEach(cleanup)

  it('marks exactly the selected row, follows ArrowDown, and paints it in a colour the list does not have', async () => {
    const user = userEvent.setup()
    render(
      <Command>
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandItem>First</CommandItem>
          <CommandItem>Second</CommandItem>
          <CommandItem>Third</CommandItem>
        </CommandList>
      </Command>,
    )
    const selected = (): string[] =>
      screen
        .getAllByRole('option')
        .filter((row) => row.getAttribute('data-selected') === 'true')
        .map((row) => row.textContent ?? '')

    expect(selected()).toEqual(['First'])
    await user.click(screen.getByPlaceholderText('Search'))
    await user.keyboard('{ArrowDown}')
    expect(selected()).toEqual(['Second'])

    const row = screen.getByRole('option', { name: 'Second' })
    const list = row.closest('[data-slot="command"]')
    if (!list) throw new Error('no command root')
    expect(
      themesWhereSame(backgroundTokenOf(row, 'data-selected:'), backgroundTokenOf(list)),
    ).toEqual([])
  })
})
