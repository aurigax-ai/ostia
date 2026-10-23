import '@testing-library/jest-dom/vitest'
import { ShieldWarningIcon } from '@phosphor-icons/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptCard } from './PromptCard'

afterEach(cleanup)

describe('PromptCard', () => {
  it('shows the title, the body and the actions, and its close button says what it does', () => {
    const onDismiss = vi.fn()
    render(
      <PromptCard
        icon={ShieldWarningIcon}
        label="Permission request"
        title="claude wants to read terminal output"
        actions={<button type="button">Allow once</button>}
        dismissLabel="Decide later"
        onDismiss={onDismiss}
      >
        pnpm test
      </PromptCard>,
    )

    const card = screen.getByRole('region', { name: 'Permission request' })
    expect(card).toHaveTextContent('claude wants to read terminal output')
    expect(card).toHaveTextContent('pnpm test')
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('floats at the bottom right and never grows past 560 px', () => {
    render(
      <PromptCard
        icon={ShieldWarningIcon}
        label="Card"
        title="Title"
        dismissLabel="Close"
        onDismiss={() => {}}
      />,
    )

    const card = screen.getByRole('region', { name: 'Card' })
    expect(card).toHaveClass(
      'absolute',
      'bottom-3',
      'right-3',
      'origin-bottom-right',
      'max-w-[560px]',
    )
  })
})
