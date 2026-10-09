import { localFontFamilies } from '@/lib/localFonts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FontPicker } from './FontPicker'

vi.mock('@/lib/localFonts', () => ({ localFontFamilies: vi.fn() }))

const families = vi.mocked(localFontFamilies)

async function openPicker(): Promise<void> {
  const input = screen.getByRole('combobox', { name: 'Editor font' })
  await act(async () => {
    fireEvent.focus(input)
    fireEvent.click(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
  })
}

async function closePicker(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Editor font' }), { key: 'Escape' })
  })
}

describe('FontPicker', () => {
  afterEach(() => families.mockReset())

  it('shows the no-fonts text when the list is empty', async () => {
    families.mockResolvedValue([])
    render(<FontPicker value="Inter" label="Editor font" onChange={() => {}} />)
    await openPicker()
    const empty = await screen.findByText('No installed font matches')
    expect(empty.closest('[data-slot="combobox-content"]')?.hasAttribute('data-empty')).toBe(true)
  })

  it('loads the fonts again when the picker reopens after an empty load', async () => {
    let installed: string[] = []
    families.mockImplementation(async () => installed)
    render(<FontPicker value="Inter" label="Editor font" onChange={() => {}} />)
    await openPicker()
    await screen.findByText('No installed font matches')
    await closePicker()
    installed = ['Fira Code', 'Inter']
    await openPicker()
    expect(await screen.findByRole('option', { name: 'Fira Code' })).toBeTruthy()
  })
})
