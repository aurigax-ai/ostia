import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { backgroundTokenOf, themesWhereSame } from '../../../../test/themeColours'
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from './combobox'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

function surfaceOf(item: Element, slot: string): Element {
  const surface = item.closest(`[data-slot="${slot}"]`)
  if (!surface) throw new Error(`no ${slot} around ${item.textContent}`)
  return surface
}

async function highlighted(name: string): Promise<Element> {
  const item = (): Element | null => screen.getByText(name).closest('[data-highlighted]')
  await waitFor(() => expect(item()).not.toBeNull())
  return item() as Element
}

describe('highlighted item of a popup', () => {
  afterEach(cleanup)

  it.each(['Item', 'Checkbox', 'Radio', 'More'])(
    'context menu %s row is painted in a colour its menu does not have',
    async (name) => {
      const user = userEvent.setup()
      await renderSettled(
        <ContextMenu>
          <ContextMenuTrigger>Target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Item</ContextMenuItem>
            <ContextMenuCheckboxItem checked>Checkbox</ContextMenuCheckboxItem>
            <ContextMenuRadioGroup value="radio">
              <ContextMenuRadioItem value="radio">Radio</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
            <ContextMenuSub>
              <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem>Inner</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>,
      )
      fireEvent.contextMenu(screen.getByText('Target'))
      await screen.findByText(name)
      await user.hover(screen.getByText(name))
      const item = await highlighted(name)
      const menu = surfaceOf(item, 'context-menu-content')
      expect(themesWhereSame(backgroundTokenOf(item, 'focus:'), backgroundTokenOf(menu))).toEqual(
        [],
      )
    },
  )

  it('select option is painted in a colour its list does not have', async () => {
    const user = userEvent.setup()
    await renderSettled(
      <Select defaultValue="one">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
          <SelectItem value="two">Two</SelectItem>
        </SelectContent>
      </Select>,
    )
    await user.click(screen.getByRole('combobox'))
    await user.hover(await screen.findByRole('option', { name: 'Two' }))
    const item = await highlighted('Two')
    const list = surfaceOf(item, 'select-content')
    expect(themesWhereSame(backgroundTokenOf(item, 'focus:'), backgroundTokenOf(list))).toEqual([])
  })

  it('combobox option is painted in a colour its list does not have', async () => {
    const user = userEvent.setup()
    await renderSettled(
      <Combobox items={['Alpha', 'Beta']}>
        <ComboboxInput placeholder="Pick" />
        <ComboboxContent>
          <ComboboxList>
            {(entry: string) => (
              <ComboboxItem key={entry} value={entry}>
                {entry}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>,
    )
    await user.click(screen.getByPlaceholderText('Pick'))
    await user.keyboard('{ArrowDown}')
    const item = await highlighted('Alpha')
    const list = surfaceOf(item, 'combobox-content')
    expect(
      themesWhereSame(backgroundTokenOf(item, 'data-highlighted:'), backgroundTokenOf(list)),
    ).toEqual([])
  })
})
