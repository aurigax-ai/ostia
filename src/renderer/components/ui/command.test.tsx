import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { Command, CommandInput, CommandItem, CommandList } from './command'

const CSS = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')

function colourOf(variable: string): string {
  const declared = new RegExp(`--${variable}:\\s*([^;]+);`).exec(CSS)?.[1]?.trim()
  if (!declared) return variable
  const alias = /^var\(--([\w-]+)\)$/.exec(declared)
  return alias ? colourOf(alias[1]) : declared
}

function backgroundOf(element: Element, variant = ''): string {
  const pattern = new RegExp(`(?:^|\\s)${variant.replace(':', '\\:')}bg-([\\w-]+)(?:\\s|$)`)
  const token = pattern.exec(element.className)?.[1]
  if (!token) throw new Error(`no ${variant}bg- class on ${element.className}`)
  return colourOf(`color-${token}`)
}

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
    expect(backgroundOf(row, 'data-selected:')).not.toBe(backgroundOf(list))
  })
})
