import '@testing-library/jest-dom/vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

afterEach(cleanup)

const COMPONENTS = resolve(process.cwd(), 'src/renderer/components')

describe('EmptyState', () => {
  it('shows a block as one muted line of title and description with the action after it', () => {
    render(
      <EmptyState
        variant="block"
        title="No providers yet"
        desc="Add one to choose its models."
        action={<button type="button">Add</button>}
      />,
    )
    expect(screen.getByText('No providers yet. Add one to choose its models.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('does not double the full stop of a block title', () => {
    render(<EmptyState variant="block" title="Nothing here." />)
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
  })

  it('names a surface by its heading and offers its actions', () => {
    render(
      <EmptyState
        variant="surface"
        title="No panes"
        titleAs="h2"
        desc="Open one."
        actions={<button type="button">New</button>}
        role="status"
      />,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'No panes' })).toBeInTheDocument()
    expect(screen.getByText('Open one.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toContainElement(screen.getByRole('button', { name: 'New' }))
  })

  it('writes each description line of a surface as its own line', () => {
    render(<EmptyState variant="surface" desc={['https://x.test', 'refused']} />)
    expect(screen.getByText('https://x.test')).toBeInTheDocument()
    expect(screen.getByText('refused')).toBeInTheDocument()
  })
})

describe('empty states in the renderer', () => {
  it('imports ui/empty only in common/EmptyState.tsx', () => {
    const importers = readdirSync(COMPONENTS, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('ui/'))
      .filter((f) => readFileSync(join(COMPONENTS, f), 'utf8').includes("@/components/ui/empty'"))
    expect(importers).toEqual(['common/EmptyState.tsx'])
  })
})
