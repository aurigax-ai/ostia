import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SettingsList } from './SettingsList'
import { SettingsListRow } from './SettingsListRow'

afterEach(cleanup)

function renderList(node: React.ReactNode): void {
  render(<TooltipProvider delay={0}>{node}</TooltipProvider>)
}

describe('SettingsList', () => {
  it('names the list and holds its rows', () => {
    renderList(
      <SettingsList label="Patterns" empty="No patterns.">
        <SettingsListRow title="a" />
        <SettingsListRow title="b" />
      </SettingsList>,
    )
    const list = screen.getByRole('list', { name: 'Patterns' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('No patterns.')).toBeNull()
  })

  it('shows one muted line and no list when there are no rows', () => {
    renderList(<SettingsList label="Patterns" empty="No patterns." />)
    expect(screen.getByText('No patterns.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('treats an empty array of rows as empty', () => {
    renderList(
      <SettingsList label="Patterns" empty="No patterns.">
        {[].map((x) => (
          <SettingsListRow key={x} title={x} />
        ))}
      </SettingsList>,
    )
    expect(screen.getByText('No patterns.')).toBeInTheDocument()
  })

  it('renders an ordered list named by another element', () => {
    renderList(
      <>
        <h3 id="heading">Selected</h3>
        <SettingsList ordered label="Selected" labelledBy="heading" empty="None.">
          <SettingsListRow title="cwd" />
        </SettingsList>
      </>,
    )
    const list = screen.getByRole('list', { name: 'Selected' })
    expect(list.tagName).toBe('OL')
    expect(list).toHaveAttribute('aria-labelledby', 'heading')
    expect(list).not.toHaveAttribute('aria-label')
  })

  it('puts the add row after the list, also when the list is empty', () => {
    renderList(
      <SettingsList
        label="Patterns"
        empty="No patterns."
        add={<button type="button">Add</button>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})
