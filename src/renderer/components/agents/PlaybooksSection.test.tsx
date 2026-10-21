import '@testing-library/jest-dom/vitest'
import { BUILTIN_PLAYBOOKS } from '@shared/agents/playbooks'
import { en } from '@shared/app/dict'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { PlaybooksSection } from './PlaybooksSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const playbooks = () => useSettingsStore.getState().playbooks
const coordinator = BUILTIN_PLAYBOOKS[0]

async function lastWritten() {
  await vi.waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalled())
  const calls = vi.mocked(window.ostia.fs.write).mock.calls
  return JSON.parse(calls[calls.length - 1][1])
}

async function typeInto(field: HTMLElement, text: string) {
  await userEvent.clear(field)
  await userEvent.click(field)
  await userEvent.paste(text)
  await userEvent.tab()
}

describe('PlaybooksSection', () => {
  let initial: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    initial = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initial, true)
    vi.mocked(window.ostia.fs.write).mockClear()
  })

  it('lists the built-ins with only /remember on, and shows the selected prompt', () => {
    render(<PlaybooksSection />)
    for (const p of BUILTIN_PLAYBOOKS) {
      expect(screen.getByRole('switch', { name: `/${p.id}` })).toHaveProperty(
        'ariaChecked',
        p.defaultOn ? 'true' : 'false',
      )
    }
    const prompt = screen.getByRole('textbox', { name: '/coordinator prompt' })
    expect(prompt).toHaveValue(coordinator.text)
  })

  it('saves the switch to settings at once', async () => {
    render(<PlaybooksSection />)
    await userEvent.click(screen.getByRole('switch', { name: '/coordinator' }))
    expect(playbooks().enabled).toEqual({ coordinator: true })
    expect((await lastWritten()).playbooks.enabled.coordinator).toBe(true)
  })

  it('shows another playbook’s prompt when its row is chosen', async () => {
    render(<PlaybooksSection />)
    await userEvent.click(screen.getByRole('button', { name: '/worker' }))
    expect(screen.getByRole('textbox', { name: '/worker prompt' })).toHaveValue(
      BUILTIN_PLAYBOOKS[1].text,
    )
  })

  it('keeps an edit, marks it Edited, and resets to Ostia’s default', async () => {
    render(<PlaybooksSection />)
    const prompt = screen.getByRole('textbox', { name: '/coordinator prompt' })
    await typeInto(prompt, 'Be brief.')
    expect(playbooks().edits.coordinator.text).toBe('Be brief.')
    expect((await lastWritten()).playbooks.edits.coordinator.text).toBe('Be brief.')
    expect(screen.getByText(en.playbooks.edited)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.resetDefault }))
    expect(playbooks().edits).toEqual({})
    expect(screen.queryByText(en.playbooks.edited)).toBeNull()
  })

  it('refuses a prompt that runs a command and keeps the old text', async () => {
    render(<PlaybooksSection />)
    await typeInto(screen.getByRole('textbox', { name: '/coordinator prompt' }), 'Run !`id` now')
    expect(screen.getByRole('alert')).toHaveTextContent(/runs a command/)
    expect(playbooks().edits).toEqual({})
  })

  it('says the default changed only when it did, keeping the human text', async () => {
    useSettingsStore.setState({
      playbooks: {
        enabled: {},
        edits: { coordinator: { text: 'Mine.', from: '00000000' } },
        own: {},
      },
    })
    render(<PlaybooksSection />)
    expect(screen.getByText(/default changed\. Your edit is kept\./)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '/coordinator prompt' })).toHaveValue('Mine.')
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.showDefault }))
    expect(screen.getByText(/You plan, dispatch, review and merge/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.reset }))
    expect(playbooks().edits).toEqual({})
  })

  it('stays quiet when an edit still matches the current default', async () => {
    render(<PlaybooksSection />)
    await typeInto(screen.getByRole('textbox', { name: '/coordinator prompt' }), 'Mine.')
    expect(screen.queryByText(/default changed/)).toBeNull()
  })

  it('creates an own playbook in Settings and lists it as Yours, off', async () => {
    render(<PlaybooksSection />)
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.newPlaybook }))
    await typeInto(screen.getByRole('textbox', { name: en.playbooks.command }), '/review')
    expect(screen.getByRole('alert')).toHaveTextContent('/review is a built-in name.')
    await typeInto(screen.getByRole('textbox', { name: en.playbooks.command }), '/release-check')
    await typeInto(screen.getByRole('textbox', { name: en.playbooks.description }), 'Before a tag')
    await typeInto(
      screen.getByRole('textbox', { name: en.playbooks.newPlaybook }),
      'Confirm the tests pass.',
    )
    expect(playbooks().own['release-check']).toEqual({
      description: 'Before a tag',
      text: 'Confirm the tests pass.',
      enabled: false,
    })
    expect((await lastWritten()).playbooks.own['release-check'].text).toBe(
      'Confirm the tests pass.',
    )
    const row = screen.getByRole('button', { name: '/release-check' }).closest('li') as HTMLElement
    expect(within(row).getByText(en.playbooks.yours)).toBeInTheDocument()
    expect(within(row).getByRole('switch')).toHaveProperty('ariaChecked', 'false')
    expect(screen.getByRole('textbox', { name: '/release-check prompt' })).toHaveValue(
      'Confirm the tests pass.',
    )
  })

  it('renames an own playbook, refuses a clash, and deletes it', async () => {
    useSettingsStore.setState({
      playbooks: {
        enabled: {},
        edits: {},
        own: {
          mine: { description: 'Mine', text: 'Do it.', enabled: true },
          other: { description: 'Other', text: 'Do that.', enabled: false },
        },
      },
    })
    render(<PlaybooksSection />)
    await userEvent.click(screen.getByRole('button', { name: '/mine' }))
    const command = screen.getByRole('textbox', { name: en.playbooks.command })
    await typeInto(command, '/other')
    expect(screen.getByRole('alert')).toHaveTextContent('/other is already a playbook.')
    expect(Object.keys(playbooks().own)).toEqual(['mine', 'other'])
    await typeInto(command, '/renamed')
    expect(Object.keys(playbooks().own).sort()).toEqual(['other', 'renamed'])
    expect(playbooks().own.renamed.enabled).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.delete }))
    expect(Object.keys(playbooks().own)).toEqual(['other'])
  })
})
