import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { en } from '../i18n/dict'
import { ChatToolsMenu } from './ChatToolsMenu'

afterEach(cleanup)

describe('ChatToolsMenu', () => {
  it('says tools are described in the prompt when the model has no native tool calling', async () => {
    render(<ChatToolsMenu sessionId="s1" mode="prompted" />)
    await userEvent.click(screen.getByRole('button', { name: en.chatTools.menuTitle }))
    expect(await screen.findByText(en.chatTools.prompted)).toBeInTheDocument()
  })

  it('shows no such note when the model calls tools natively', async () => {
    render(<ChatToolsMenu sessionId="s1" mode="native" />)
    await userEvent.click(screen.getByRole('button', { name: en.chatTools.menuTitle }))
    expect(await screen.findByText(en.chatTools.menuDesc)).toBeInTheDocument()
    expect(screen.queryByText(en.chatTools.prompted)).not.toBeInTheDocument()
  })
})
