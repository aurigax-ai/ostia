import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createPane } from '@/lib/layout/tree'
import { TabFace } from './TabFace'

afterEach(cleanup)

describe('TabFace', () => {
  it('marks a tab that is kept awake, and no other', () => {
    const { rerender } = render(
      <TooltipProvider>
        <TabFace pane={createPane('terminal')} />
      </TooltipProvider>,
    )
    expect(screen.queryByRole('img', { name: 'Kept awake' })).toBeNull()
    rerender(
      <TooltipProvider>
        <TabFace pane={{ ...createPane('terminal'), keepAwake: true }} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('img', { name: 'Kept awake' })).toBeInTheDocument()
  })
})
