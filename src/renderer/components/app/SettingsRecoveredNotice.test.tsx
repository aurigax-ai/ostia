import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsRecoveredNotice } from './SettingsRecoveredNotice'

const open = vi.hoisted(() => vi.fn())
vi.mock('@/lib/files/openFile', () => ({ openFileInWorkspace: open }))

afterEach(cleanup)
beforeEach(() => open.mockReset())

describe('SettingsRecoveredNotice', () => {
  it('shows nothing when settings were read fine', async () => {
    const { container } = render(<SettingsRecoveredNotice />)
    await vi.waitFor(() => expect(window.ostia.settings.recovered).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('names the saved copy and opens it', async () => {
    vi.mocked(window.ostia.settings.recovered).mockResolvedValue('/data/settings.json.corrupt-1')
    render(<SettingsRecoveredNotice />)
    expect(await screen.findByText(/settings\.json\.corrupt-1/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open the copy' }))
    expect(open).toHaveBeenCalledWith('/data/settings.json.corrupt-1')
    expect(screen.queryByText(/settings\.json\.corrupt-1/)).toBeNull()
  })
})
