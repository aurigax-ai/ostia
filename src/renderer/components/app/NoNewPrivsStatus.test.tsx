import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { NoNewPrivsStatus } from './NoNewPrivsStatus'

afterEach(cleanup)

function setNoNewPrivs(value: boolean): void {
  window.ostia.system.noNewPrivs = value
}

describe('NoNewPrivsStatus', () => {
  it('shows nothing when the app runs without the flag', () => {
    setNoNewPrivs(false)
    const { container } = render(<NoNewPrivsStatus />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says sudo will not work and how to fix it, until dismissed', async () => {
    setNoNewPrivs(true)
    render(<NoNewPrivsStatus />)
    expect(screen.getByRole('status')).toHaveTextContent('sudo will not work in terminals')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
