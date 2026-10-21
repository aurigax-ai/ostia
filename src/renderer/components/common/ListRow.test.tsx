import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ListRow, type ListRowProps } from './ListRow'

afterEach(cleanup)

function renderRow(props: ListRowProps): void {
  render(
    <TooltipProvider delay={0}>
      <ul>
        <ListRow {...props} />
      </ul>
    </TooltipProvider>,
  )
}

describe('ListRow', () => {
  it('shows the lead, title, meta, detail and actions of a row', () => {
    renderRow({
      title: 'Build',
      lead: <span data-testid="lead" />,
      meta: 'Trusted',
      detail: 'pnpm build',
      actions: <button type="button">Remove</button>,
    })
    expect(screen.getByRole('listitem')).toBeInTheDocument()
    expect(screen.getByTestId('lead')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('Trusted')).toBeInTheDocument()
    expect(screen.getByText('pnpm build')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('has no toggle without an expanded block', () => {
    renderRow({ title: 'Build' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('discloses the expanded block with a keyboard-operable toggle that names it', async () => {
    renderRow({ title: 'Build', expanded: <p>Version 1.0</p>, expandLabel: 'Details' })
    const toggle = screen.getByRole('button', { name: 'Details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Version 1.0')).not.toBeVisible()
    await act(async () => toggle.focus())
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Version 1.0')).toBeVisible()
    const region = screen.getByRole('region', { name: 'Details' })
    expect(toggle.getAttribute('aria-controls')).toBe(region.id)
    await userEvent.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens an expanded block that starts open', () => {
    renderRow({
      title: 'Build',
      expanded: <p>Version 1.0</p>,
      expandLabel: 'Details',
      defaultOpen: true,
    })
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Version 1.0')).toBeVisible()
  })
})
