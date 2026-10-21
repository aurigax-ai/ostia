import '@testing-library/jest-dom/vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Notice } from './Notice'

afterEach(cleanup)

const COMPONENTS = resolve(process.cwd(), 'src/renderer/components')

const KNOWN_ALERT_IMPORTERS = [
  'ai-elements/confirmation.tsx',
  'common/Notice.tsx',
  'editor/ArtifactVersions.tsx',
]

describe('Notice', () => {
  it('shows its message in the tone colour with the actions after it', () => {
    render(<Notice actions={<button type="button">Fix</button>}>Folder is missing</Notice>)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Folder is missing')
    expect(alert).toHaveClass('text-warn-fg')
    expect(screen.getByRole('button', { name: 'Fix' })).toBeInTheDocument()
  })

  it('colours an error and an info notice differently from a warning', () => {
    render(
      <>
        <Notice tone="error">Broke</Notice>
        <Notice tone="info">FYI</Notice>
      </>,
    )
    const [error, info] = screen.getAllByRole('alert')
    expect(error).toHaveClass('text-attn-fg')
    expect(info).toHaveClass('text-fg-muted')
  })
})

describe('notices in the renderer', () => {
  const files = readdirSync(COMPONENTS, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('ui/'))
    .map((f) => ({ file: f, text: readFileSync(join(COMPONENTS, f), 'utf8') }))

  it('builds a note under a row or in a strip on Notice, never a second warning component', () => {
    expect(files.filter((f) => f.text.includes('WarningNote')).map((f) => f.file)).toEqual([])
  })

  it('imports ui/alert only where the known list says, so the list can only shrink', () => {
    const importers = files
      .filter((f) => f.text.includes("@/components/ui/alert'"))
      .map((f) => f.file)
      .sort()
    expect(importers).toEqual(KNOWN_ALERT_IMPORTERS)
  })
})
