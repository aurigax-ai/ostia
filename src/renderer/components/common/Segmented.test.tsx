import { ListBulletsIcon, TreeStructureIcon } from '@phosphor-icons/react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Segmented } from './Segmented'

afterEach(cleanup)

const OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'changes', label: 'My changes (0)' },
]

describe('Segmented', () => {
  it('is one labelled group whose chosen option is pressed', () => {
    render(<Segmented label="View" value="active" options={OPTIONS} onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'My changes (0)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('reports the option that was clicked', async () => {
    const onChange = vi.fn()
    render(<Segmented label="View" value="active" options={OPTIONS} onChange={onChange} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'My changes (0)' }))
    expect(onChange).toHaveBeenCalledWith('changes')
  })

  it('names an icon-only option by its label', () => {
    render(
      <TooltipProvider>
        <Segmented
          iconOnly
          label="View as"
          value="list"
          options={[
            { value: 'list', label: 'List', icon: ListBulletsIcon },
            { value: 'tree', label: 'Tree', icon: TreeStructureIcon },
          ]}
          onChange={() => {}}
        />
      </TooltipProvider>,
    )
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Tree' }).textContent).toBe('')
  })
})
