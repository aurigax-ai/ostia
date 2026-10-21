import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineValue } from '@/components/common/MachineValue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ControlRow } from './ControlRow'

const INSTALL_ID = '92c5cc36-ec25-428e-99ec-6cc83cd729e6'

function renderInstallIdRow(): HTMLElement {
  render(
    <TooltipProvider delay={0}>
      <ControlRow label="Install id" desc="A random id that groups reports from this installation.">
        <MachineValue value={INSTALL_ID} label="Install id" />
        <button type="button">Reset install id</button>
      </ControlRow>
    </TooltipProvider>,
  )
  const row = screen.getByText('Install id').closest('[data-settings-row]')
  if (!(row instanceof HTMLElement)) throw new Error('no settings row')
  return row
}

describe('ControlRow', () => {
  afterEach(cleanup)

  it('wraps a control that does not fit below a text column that keeps its minimum width', () => {
    const row = renderInstallIdRow()
    const [text, control] = Array.from(row.children)
    expect(row).toHaveClass('flex', 'flex-wrap')
    expect(text).toHaveAttribute('data-settings-row-text')
    expect(text).toHaveClass('grow', 'basis-96', 'min-w-0')
    expect(text).toHaveTextContent('A random id that groups reports from this installation.')
    expect(control).toHaveAttribute('data-settings-row-control')
    expect(control).toHaveClass('min-w-0', 'max-w-full')
    expect(control).not.toHaveClass('shrink-0')
    expect(control).toContainElement(screen.getByRole('button', { name: 'Reset install id' }))
  })

  it('truncates a long machine value and shows all of it in a tooltip', async () => {
    renderInstallIdRow()
    const value = screen.getByLabelText('Install id')
    expect(value).toHaveClass('truncate', 'min-w-0')
    expect(value).toHaveTextContent(INSTALL_ID)
    await userEvent.hover(value)
    expect(await screen.findAllByText(INSTALL_ID)).toHaveLength(2)
  })
})
