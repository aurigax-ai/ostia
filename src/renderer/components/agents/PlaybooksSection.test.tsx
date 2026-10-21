import '@testing-library/jest-dom/vitest'
import { BUILTIN_PLAYBOOKS } from '@shared/agents/playbooks'
import { en } from '@shared/app/dict'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
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
    useExtensionsStore.setState({ list: [] })
    vi.mocked(window.ostia.fs.write).mockClear()
  })

  it('lists the built-ins, all off, and shows the selected prompt', () => {
    render(<PlaybooksSection />)
    for (const p of BUILTIN_PLAYBOOKS) {
      expect(screen.getByRole('switch', { name: `/${p.id}` })).toHaveProperty(
        'ariaChecked',
        'false',
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
        accepted: { coordinator: 'Mine.' },
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
    })
    expect(playbooks().enabled).toEqual({})
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
        enabled: { mine: true },
        accepted: { mine: 'Do it.', other: 'Do that.' },
        edits: {},
        own: {
          mine: { description: 'Mine', text: 'Do it.' },
          other: { description: 'Other', text: 'Do that.' },
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
    expect(playbooks().enabled).toEqual({ renamed: true })
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.delete }))
    expect(Object.keys(playbooks().own)).toEqual(['other'])
  })

  it('keeps an edit that arrived from another device waiting until it is accepted here', async () => {
    useSettingsStore.setState({
      playbooks: {
        enabled: { coordinator: true },
        accepted: {},
        edits: { coordinator: { text: 'Pushed from elsewhere.', from: '00000000' } },
        own: {},
      },
    })
    render(<PlaybooksSection />)
    expect(screen.getByText(en.playbooks.changedElsewhere)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '/coordinator prompt' })).toHaveValue(
      coordinator.text,
    )
    expect(screen.queryByText(en.playbooks.defaultChanged.replace('{product}', 'Ostia'))).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.showDefault }))
    expect(screen.getByText('Pushed from elsewhere.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.useIt }))
    expect(playbooks().accepted.coordinator).toBe('Pushed from elsewhere.')
    expect(screen.getByRole('textbox', { name: '/coordinator prompt' })).toHaveValue(
      'Pushed from elsewhere.',
    )
    expect(screen.queryByText(en.playbooks.changedElsewhere)).toBeNull()
  })

  it('arrives off and unusable for an own playbook from another device, until accepted', async () => {
    useSettingsStore.setState({
      playbooks: {
        enabled: {},
        accepted: {},
        edits: {},
        own: { synced: { description: 'From elsewhere', text: 'Do it.' } },
      },
    })
    render(<PlaybooksSection />)
    const row = screen.getByRole('button', { name: '/synced' }).closest('li') as HTMLElement
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('button', { name: '/synced' }))
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.useIt }))
    expect(within(row).getByRole('switch')).not.toHaveAttribute('aria-disabled', 'true')
    expect(within(row).getByRole('switch')).toHaveProperty('ariaChecked', 'false')
  })

  it('refuses a command an installed extension’s skill already has, and a Claude Code command', async () => {
    useExtensionsStore.setState({
      list: [
        { id: 'changelog', agentSkills: ['changelog-draft'] } as never,
        { id: 'activity', agentSkills: ['activity', 'remember'] } as never,
      ],
    })
    render(<PlaybooksSection />)
    await userEvent.click(screen.getByRole('button', { name: en.playbooks.newPlaybook }))
    const command = () => screen.getByRole('textbox', { name: en.playbooks.command })
    await typeInto(command(), '/changelog-draft')
    expect(screen.getByRole('alert')).toHaveTextContent(
      '/changelog-draft is a skill of an installed extension.',
    )
    await typeInto(command(), '/remember')
    expect(screen.getByRole('alert')).toHaveTextContent(
      '/remember is a skill of an installed extension.',
    )
    await typeInto(command(), '/compact')
    expect(screen.getByRole('alert')).toHaveTextContent('/compact is a built-in name.')
    expect(playbooks().own).toEqual({})
  })

  it('says why an own playbook is not in use once an extension takes its name', async () => {
    useSettingsStore.setState({
      playbooks: {
        enabled: { mine: true },
        accepted: { mine: 'Do it.' },
        edits: {},
        own: { mine: { description: 'Mine', text: 'Do it.' } },
      },
    })
    useExtensionsStore.setState({ list: [{ id: 'x', agentSkills: ['mine'] } as never] })
    render(<PlaybooksSection />)
    const row = screen.getByRole('button', { name: '/mine' }).closest('li') as HTMLElement
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('button', { name: '/mine' }))
    expect(screen.getByText(/also a skill of an installed extension/)).toBeInTheDocument()
  })
})
