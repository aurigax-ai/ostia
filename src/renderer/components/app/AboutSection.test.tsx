import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AboutSection } from './AboutSection'

describe('AboutSection', () => {
  afterEach(cleanup)

  it('keeps the identity block and lists updates and this computer as rows', async () => {
    render(<AboutSection />)

    const about = screen.getByRole('region', { name: 'About' })
    expect(within(about).getByRole('heading', { name: /ostia/i })).toBeVisible()
    expect(within(about).queryByRole('button', { name: 'Check for updates' })).toBeNull()

    expect(screen.getByRole('heading', { name: 'Updates' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'This computer' })).toBeVisible()
    expect(screen.getByText('Operating system')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Open log folder' }))
    expect(window.ostia.diagnostics.openLogFolder).toHaveBeenCalled()
  })
})
