import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasswordsSection } from './PasswordsSection'

const SAVED = [{ id: 'c1', origin: 'https://github.com', username: 'me', updatedAt: 1 }]

describe('PasswordsSection', () => {
  afterEach(() => {
    vi.mocked(window.ostia.credentials.list).mockResolvedValue([])
    vi.mocked(window.ostia.credentials.remove).mockClear()
    vi.mocked(window.ostia.credentials.save).mockClear()
  })

  it('lists saved logins without passwords and copies one through main', async () => {
    vi.mocked(window.ostia.credentials.list).mockResolvedValue(SAVED)
    render(<PasswordsSection />)

    expect(await screen.findByText('https://github.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy password for https://github.com' }))
    expect(window.ostia.credentials.copyPassword).toHaveBeenCalledWith('c1')
    expect(await screen.findByText('Password copied to the clipboard.')).toBeTruthy()
  })

  it('deletes a login only after the confirm dialog', async () => {
    vi.mocked(window.ostia.credentials.list).mockResolvedValue(SAVED)
    render(<PasswordsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete login for https://github.com' }),
    )
    expect(window.ostia.credentials.remove).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(window.ostia.credentials.remove).toHaveBeenCalledWith('c1'))
  })

  it('saves a new login from the form', async () => {
    render(<PasswordsSection />)
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'https://x.dev' } })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'me' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save login' }))
    await waitFor(() =>
      expect(window.ostia.credentials.save).toHaveBeenCalledWith({
        origin: 'https://x.dev',
        username: 'me',
        password: 'pw',
      }),
    )
    expect(await screen.findByText('Login saved.')).toBeTruthy()
  })
})
