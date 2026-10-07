import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { Hint } from './Hint'
import { ItemDescription, ItemTitle } from './ui/item'

describe('Hint', () => {
  it('anchors on an item title and description, which take the trigger ref', () => {
    const title = createRef<HTMLDivElement>()
    const description = createRef<HTMLParagraphElement>()
    render(
      <>
        <ItemTitle ref={title}>Title</ItemTitle>
        <ItemDescription ref={description}>Description</ItemDescription>
        <Hint label="Full title">
          <ItemTitle>Hinted title</ItemTitle>
        </Hint>
        <Hint label="Full description">
          <ItemDescription>Hinted description</ItemDescription>
        </Hint>
      </>,
    )
    expect(title.current).toBe(screen.getByText('Title'))
    expect(description.current).toBe(screen.getByText('Description'))
    expect(screen.getByText('Hinted title')).toHaveAttribute('data-slot', 'tooltip-trigger')
    expect(screen.getByText('Hinted description')).toHaveAttribute('data-slot', 'tooltip-trigger')
  })
})
